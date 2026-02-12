//! DWARF debug info parser — extracts enums, structs, and variables
//! from firmware object files inside a static library archive.

use crate::types::*;
use gimli::{
    AttributeValue, DebuggingInformationEntry, Dwarf, EndianSlice,
    RunTimeEndian, Unit, UnitOffset,
};
use object::read::archive::ArchiveFile;
use object::{Object, ObjectSection};
use std::collections::HashMap;
use std::path::Path;
use tracing::{debug, info, trace};

type GimliReader<'a> = EndianSlice<'a, RunTimeEndian>;

impl FirmwareInfo {
    /// Parse all DWARF debug info from a firmware static library archive.
    ///
    /// Iterates through every `.o` file in the `.a` archive, extracts
    /// enum definitions, struct layouts, and variable declarations.
    pub fn from_archive(archive_path: &Path) -> Result<Self, String> {
        let file_data = std::fs::read(archive_path)
            .map_err(|e| format!("Failed to read {}: {}", archive_path.display(), e))?;

        let archive = ArchiveFile::parse(&*file_data)
            .map_err(|e| format!("Failed to parse archive: {}", e))?;

        let mut info = FirmwareInfo::new();
        let mut obj_count = 0;

        for member in archive.members() {
            let member = member.map_err(|e| format!("Failed to read archive member: {}", e))?;
            let name = String::from_utf8_lossy(member.name()).to_string();

            let data = member.data(&*file_data)
                .map_err(|e| format!("Failed to read data for {}: {}", name, e))?;

            // Try to parse as an object file
            match object::File::parse(data) {
                Ok(obj) => {
                    trace!("Parsing DWARF from: {}", name);
                    if let Err(e) = parse_object_dwarf(&obj, &mut info) {
                        debug!("DWARF parse warning for {}: {}", name, e);
                    }
                    obj_count += 1;
                }
                Err(_) => {
                    trace!("Skipping non-object member: {}", name);
                }
            }
        }

        info!(
            "Parsed {} object files: {} enums ({} variants), {} structs, {} variables",
            obj_count,
            info.enums.len(),
            info.enum_variants.len(),
            info.structs.len(),
            info.variables.len(),
        );

        Ok(info)
    }
}

/// Parse DWARF from a single object file and add to FirmwareInfo.
fn parse_object_dwarf(obj: &object::File, info: &mut FirmwareInfo) -> Result<(), String> {
    // Load DWARF sections
    let endian = if obj.is_little_endian() {
        RunTimeEndian::Little
    } else {
        RunTimeEndian::Big
    };

    let load_section = |id: gimli::SectionId| -> Result<EndianSlice<RunTimeEndian>, String> {
        let data = obj
            .section_by_name(id.name())
            .and_then(|s| s.data().ok())
            .unwrap_or(&[]);
        Ok(EndianSlice::new(data, endian))
    };

    let dwarf = Dwarf::load(&load_section)
        .map_err(|e| format!("Failed to load DWARF: {}", e))?;

    // Iterate through compilation units
    let mut units = dwarf.units();
    while let Ok(Some(header)) = units.next() {
        let unit = dwarf.unit(header)
            .map_err(|e| format!("Failed to parse unit: {}", e))?;

        // First pass: build a type map (offset → type info) for this compilation unit
        let type_map = build_type_map(&dwarf, &unit)?;

        // Second pass: extract named enums, structs, and variables
        extract_entries(&dwarf, &unit, &type_map, info)?;
    }

    Ok(())
}

// ============================================================
// Type resolution
// ============================================================

/// Intermediate type representation during parsing.
#[derive(Debug, Clone)]
enum DwarfType {
    Base {
        name: String,
        byte_size: usize,
        signed: bool,
    },
    Enum {
        typedef_name: Option<String>,
        byte_size: usize,
        variants: Vec<(String, i64)>,
    },
    Struct {
        typedef_name: Option<String>,
        byte_size: usize,
        fields: Vec<(String, usize, UnitOffset)>, // (name, offset, type_offset)
    },
    Array {
        element_type: UnitOffset,
        count: usize,
    },
    Typedef {
        _name: String,
        target: UnitOffset,
    },
    Pointer {
        byte_size: usize,
    },
    /// Function pointer or other types we track but don't deeply resolve
    Opaque {
        byte_size: usize,
    },
}

/// Build a map of DWARF offset → DwarfType for all type entries in a unit.
fn build_type_map(
    dwarf: &Dwarf<GimliReader>,
    unit: &Unit<GimliReader>,
) -> Result<HashMap<UnitOffset, DwarfType>, String> {
    let mut map = HashMap::new();
    let mut entries = unit.entries();

    while let Ok(Some((_, entry))) = entries.next_dfs() {
        let offset = entry.offset();

        let dtype = match entry.tag() {
            gimli::DW_TAG_base_type => parse_base_type(dwarf, entry),
            gimli::DW_TAG_enumeration_type => parse_enumeration(dwarf, unit, entry),
            gimli::DW_TAG_structure_type => parse_structure(dwarf, unit, entry),
            gimli::DW_TAG_array_type => parse_array(unit, entry),
            gimli::DW_TAG_typedef => parse_typedef(dwarf, entry),
            gimli::DW_TAG_pointer_type => Some(DwarfType::Pointer {
                byte_size: entry
                    .attr_value(gimli::DW_AT_byte_size)
                    .ok()
                    .flatten()
                    .and_then(|v| attr_to_usize(&v))
                    .unwrap_or(8), // default pointer size
            }),
            gimli::DW_TAG_subroutine_type => Some(DwarfType::Opaque { byte_size: 8 }),
            gimli::DW_TAG_const_type | gimli::DW_TAG_volatile_type => {
                // Qualifiers: follow through to the target type
                if let Some(target) = get_type_ref(entry) {
                    Some(DwarfType::Typedef {
                        _name: String::new(),
                        target,
                    })
                } else {
                    None
                }
            }
            _ => None,
        };

        if let Some(dt) = dtype {
            map.insert(offset, dt);
        }
    }

    // Second pass: propagate typedef names onto their target struct/enum types.
    // This ensures that when an array element references an anonymous struct,
    // it gets the typedef name (e.g., "dev_cogManager_channelData_S").
    let typedef_targets: Vec<(String, UnitOffset)> = map
        .iter()
        .filter_map(|(_, dt)| {
            if let DwarfType::Typedef { _name, target } = dt {
                if !_name.is_empty() {
                    Some((_name.clone(), *target))
                } else {
                    None
                }
            } else {
                None
            }
        })
        .collect();

    for (name, target) in typedef_targets {
        // Follow through const/volatile qualifiers to the real type
        let mut current = target;
        for _ in 0..20 {
            match map.get(&current) {
                Some(DwarfType::Typedef { target: inner, .. }) => {
                    current = *inner;
                }
                _ => break,
            }
        }

        if let Some(dt) = map.get_mut(&current) {
            match dt {
                DwarfType::Struct { typedef_name, .. } if typedef_name.is_none() => {
                    *typedef_name = Some(name);
                }
                DwarfType::Enum { typedef_name, .. } if typedef_name.is_none() => {
                    *typedef_name = Some(name);
                }
                _ => {}
            }
        }
    }

    Ok(map)
}

/// Resolve a DwarfType to a TypeInfo, following typedefs.
fn resolve_type(
    type_map: &HashMap<UnitOffset, DwarfType>,
    offset: UnitOffset,
) -> TypeInfo {
    resolve_type_inner(type_map, offset, 0)
}

fn resolve_type_inner(
    type_map: &HashMap<UnitOffset, DwarfType>,
    offset: UnitOffset,
    depth: usize,
) -> TypeInfo {
    if depth > 20 {
        return TypeInfo::Unknown { byte_size: 0 };
    }

    match type_map.get(&offset) {
        Some(DwarfType::Base { name, byte_size, signed }) => TypeInfo::Base {
            name: name.clone(),
            byte_size: *byte_size,
            signed: *signed,
        },
        Some(DwarfType::Enum { typedef_name, byte_size, .. }) => TypeInfo::Enum {
            type_name: typedef_name.clone().unwrap_or_default(),
            byte_size: *byte_size,
        },
        Some(DwarfType::Struct { typedef_name, byte_size, .. }) => TypeInfo::Struct {
            type_name: typedef_name.clone().unwrap_or_default(),
            byte_size: *byte_size,
        },
        Some(DwarfType::Array { element_type, count }) => {
            let elem = resolve_type_inner(type_map, *element_type, depth + 1);
            TypeInfo::Array {
                element_type: Box::new(elem),
                count: *count,
            }
        }
        Some(DwarfType::Typedef { target, .. }) => {
            resolve_type_inner(type_map, *target, depth + 1)
        }
        Some(DwarfType::Pointer { byte_size }) => TypeInfo::Pointer {
            byte_size: *byte_size,
        },
        Some(DwarfType::Opaque { byte_size }) => TypeInfo::Unknown {
            byte_size: *byte_size,
        },
        None => TypeInfo::Unknown { byte_size: 0 },
    }
}

/// Follow a type reference through typedefs to find the underlying DwarfType.
fn follow_typedefs<'a>(
    type_map: &'a HashMap<UnitOffset, DwarfType>,
    offset: UnitOffset,
) -> Option<(UnitOffset, &'a DwarfType)> {
    let mut current = offset;
    for _ in 0..20 {
        match type_map.get(&current) {
            Some(DwarfType::Typedef { target, .. }) => {
                current = *target;
            }
            Some(dt) => return Some((current, dt)),
            None => return None,
        }
    }
    None
}

// ============================================================
// Entry extraction (second pass)
// ============================================================

/// Extract named types and variables from the compilation unit.
fn extract_entries(
    dwarf: &Dwarf<GimliReader>,
    unit: &Unit<GimliReader>,
    type_map: &HashMap<UnitOffset, DwarfType>,
    info: &mut FirmwareInfo,
) -> Result<(), String> {
    let mut entries = unit.entries();

    while let Ok(Some((_, entry))) = entries.next_dfs() {
        match entry.tag() {
            gimli::DW_TAG_typedef => {
                // Typedefs pointing to enums or structs give us the _E / _S names
                let name = match get_name(dwarf, entry) {
                    Some(n) => n,
                    None => continue,
                };
                let target = match get_type_ref(entry) {
                    Some(t) => t,
                    None => continue,
                };

                if let Some((_, dtype)) = follow_typedefs(type_map, target) {
                    match dtype {
                        DwarfType::Enum { byte_size, variants, .. } => {
                            if !info.enums.contains_key(&name) {
                                let enum_info = EnumInfo {
                                    name: name.clone(),
                                    byte_size: *byte_size,
                                    variants: variants.clone(),
                                };
                                // Register all variants for flat lookup
                                for (vname, vval) in &enum_info.variants {
                                    info.enum_variants.insert(
                                        vname.clone(),
                                        (name.clone(), *vval),
                                    );
                                }
                                info.enums.insert(name, enum_info);
                            }
                        }
                        DwarfType::Struct { byte_size, fields, .. } => {
                            if !info.structs.contains_key(&name) {
                                let resolved_fields: Vec<FieldInfo> = fields
                                    .iter()
                                    .map(|(fname, foffset, ftype_offset)| {
                                        FieldInfo {
                                            name: fname.clone(),
                                            offset: *foffset,
                                            type_info: resolve_type(type_map, *ftype_offset),
                                        }
                                    })
                                    .collect();
                                info.structs.insert(
                                    name.clone(),
                                    StructInfo {
                                        name,
                                        byte_size: *byte_size,
                                        fields: resolved_fields,
                                    },
                                );
                            }
                        }
                        _ => {}
                    }
                }
            }

            gimli::DW_TAG_variable => {
                // Named variables (global or static)
                let name = match get_name(dwarf, entry) {
                    Some(n) => n,
                    None => continue,
                };
                let type_offset = match get_type_ref(entry) {
                    Some(t) => t,
                    None => continue,
                };

                let type_info = resolve_type(type_map, type_offset);

                // Get source file if available
                let source_file = entry
                    .attr_value(gimli::DW_AT_decl_file)
                    .ok()
                    .flatten()
                    .and_then(|v| {
                        if let AttributeValue::FileIndex(idx) = v {
                            let lp = unit.line_program.as_ref()?;
                            let header = lp.header();
                            let file = header.file(idx)?;
                            let name = dwarf.attr_string(unit, file.path_name()).ok()?;
                            Some(name.to_string_lossy().to_string())
                        } else {
                            None
                        }
                    });

                if !info.variables.contains_key(&name) {
                    info.variables.insert(
                        name.clone(),
                        VariableInfo {
                            name,
                            type_info,
                            source_file,
                        },
                    );
                }
            }

            _ => {}
        }
    }

    Ok(())
}

// ============================================================
// Individual DWARF entry parsers
// ============================================================

fn parse_base_type(
    dwarf: &Dwarf<GimliReader>,
    entry: &DebuggingInformationEntry<GimliReader>,
) -> Option<DwarfType> {
    let name = get_name(dwarf, entry)?;
    let byte_size = entry
        .attr_value(gimli::DW_AT_byte_size)
        .ok()??
        .udata_value()? as usize;
    let encoding = entry
        .attr_value(gimli::DW_AT_encoding)
        .ok()??;
    let signed = matches!(
        encoding,
        AttributeValue::Encoding(gimli::DW_ATE_signed | gimli::DW_ATE_signed_char)
    );
    Some(DwarfType::Base { name, byte_size, signed })
}

fn parse_enumeration(
    dwarf: &Dwarf<GimliReader>,
    unit: &Unit<GimliReader>,
    entry: &DebuggingInformationEntry<GimliReader>,
) -> Option<DwarfType> {
    let byte_size = entry
        .attr_value(gimli::DW_AT_byte_size)
        .ok()??
        .udata_value()? as usize;

    // Collect enumerator children
    let mut variants = Vec::new();
    let mut tree = unit.entries_tree(Some(entry.offset())).ok()?;
    let root = tree.root().ok()?;
    let mut children = root.children();
    while let Ok(Some(child)) = children.next() {
        let child_entry = child.entry();
        if child_entry.tag() == gimli::DW_TAG_enumerator {
            if let (Some(name), Some(value)) = (
                get_name(dwarf, child_entry),
                get_const_value(child_entry),
            ) {
                variants.push((name, value));
            }
        }
    }

    Some(DwarfType::Enum {
        typedef_name: None,
        byte_size,
        variants,
    })
}

fn parse_structure(
    dwarf: &Dwarf<GimliReader>,
    unit: &Unit<GimliReader>,
    entry: &DebuggingInformationEntry<GimliReader>,
) -> Option<DwarfType> {
    let byte_size = entry
        .attr_value(gimli::DW_AT_byte_size)
        .ok()
        .flatten()
        .and_then(|v| attr_to_usize(&v))
        .unwrap_or(0);

    // Collect member children
    let mut fields = Vec::new();
    let mut tree = unit.entries_tree(Some(entry.offset())).ok()?;
    let root = tree.root().ok()?;
    let mut children = root.children();
    while let Ok(Some(child)) = children.next() {
        let child_entry = child.entry();
        if child_entry.tag() == gimli::DW_TAG_member {
            let fname = get_name(dwarf, child_entry).unwrap_or_default();
            let foffset = child_entry
                .attr_value(gimli::DW_AT_data_member_location)
                .ok()
                .flatten()
                .and_then(|v| attr_to_usize(&v))
                .unwrap_or(0);
            let ftype = get_type_ref(child_entry).unwrap_or(UnitOffset(0));
            fields.push((fname, foffset, ftype));
        }
    }

    Some(DwarfType::Struct {
        typedef_name: None,
        byte_size,
        fields,
    })
}

fn parse_array(
    unit: &Unit<GimliReader>,
    entry: &DebuggingInformationEntry<GimliReader>,
) -> Option<DwarfType> {
    let element_type = get_type_ref(entry)?;

    // Read count from DW_TAG_subrange_type child
    let mut count = 0usize;
    if let Ok(mut tree) = unit.entries_tree(Some(entry.offset())) {
        if let Ok(root) = tree.root() {
            let mut children = root.children();
            while let Ok(Some(child)) = children.next() {
                let child_entry = child.entry();
                if child_entry.tag() == gimli::DW_TAG_subrange_type {
                    // Try DW_AT_count first, then DW_AT_upper_bound
                    if let Some(c) = child_entry
                        .attr_value(gimli::DW_AT_count)
                        .ok()
                        .flatten()
                        .and_then(|v| attr_to_usize(&v))
                    {
                        count = c;
                    } else if let Some(ub) = child_entry
                        .attr_value(gimli::DW_AT_upper_bound)
                        .ok()
                        .flatten()
                        .and_then(|v| attr_to_usize(&v))
                    {
                        count = ub + 1; // upper_bound is inclusive
                    }
                }
            }
        }
    }

    Some(DwarfType::Array {
        element_type,
        count,
    })
}

fn parse_typedef(
    dwarf: &Dwarf<GimliReader>,
    entry: &DebuggingInformationEntry<GimliReader>,
) -> Option<DwarfType> {
    let name = get_name(dwarf, entry).unwrap_or_default();
    let target = get_type_ref(entry)?;
    Some(DwarfType::Typedef { _name: name, target })
}

// ============================================================
// Attribute helpers
// ============================================================

fn get_name(
    dwarf: &Dwarf<GimliReader>,
    entry: &DebuggingInformationEntry<GimliReader>,
) -> Option<String> {
    let attr = entry.attr_value(gimli::DW_AT_name).ok()??;
    match attr {
        AttributeValue::DebugStrRef(offset) => {
            let s = dwarf.debug_str.get_str(offset).ok()?;
            Some(s.to_string_lossy().to_string())
        }
        AttributeValue::String(s) => {
            Some(s.to_string_lossy().to_string())
        }
        _ => None,
    }
}

fn get_type_ref(
    entry: &DebuggingInformationEntry<GimliReader>,
) -> Option<UnitOffset> {
    let attr = entry.attr_value(gimli::DW_AT_type).ok()??;
    match attr {
        AttributeValue::UnitRef(offset) => Some(offset),
        _ => None,
    }
}

fn get_const_value(
    entry: &DebuggingInformationEntry<GimliReader>,
) -> Option<i64> {
    let attr = entry.attr_value(gimli::DW_AT_const_value).ok()??;
    match attr {
        AttributeValue::Sdata(v) => Some(v),
        AttributeValue::Udata(v) => Some(v as i64),
        AttributeValue::Data1(v) => Some(v as i64),
        AttributeValue::Data2(v) => Some(v as i64),
        AttributeValue::Data4(v) => Some(v as i64),
        AttributeValue::Data8(v) => Some(v as i64),
        _ => None,
    }
}

fn attr_to_usize(attr: &AttributeValue<GimliReader>) -> Option<usize> {
    match attr {
        AttributeValue::Udata(v) => Some(*v as usize),
        AttributeValue::Sdata(v) => Some(*v as usize),
        AttributeValue::Data1(v) => Some(*v as usize),
        AttributeValue::Data2(v) => Some(*v as usize),
        AttributeValue::Data4(v) => Some(*v as usize),
        AttributeValue::Data8(v) => Some(*v as usize),
        _ => None,
    }
}
