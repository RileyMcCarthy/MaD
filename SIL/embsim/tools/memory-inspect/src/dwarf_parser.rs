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
    /// Parse all DWARF debug info from a firmware static library archive, using
    /// the default [`ParseOptions`].
    ///
    /// Iterates through every `.o` file in the `.a` archive, extracts
    /// enum definitions, struct layouts, and variable declarations.
    ///
    /// Returns a `String` error for backward compatibility; use
    /// [`from_archive_with`](Self::from_archive_with) for a structured error and
    /// target/convention options.
    pub fn from_archive(archive_path: &Path) -> Result<Self, String> {
        Self::from_archive_with(archive_path, &ParseOptions::default())
            .map_err(|e| e.to_string())
    }

    /// Parse a firmware archive with explicit [`ParseOptions`] (pointer size,
    /// channel-count suffix convention).
    pub fn from_archive_with(
        archive_path: &Path,
        options: &ParseOptions,
    ) -> Result<Self, MemInspectError> {
        let file_data = std::fs::read(archive_path).map_err(MemInspectError::Io)?;

        let archive = ArchiveFile::parse(&*file_data)
            .map_err(|e| MemInspectError::Archive(e.to_string()))?;

        let mut info = FirmwareInfo::new();
        info.count_suffix = options.count_suffix.clone();
        let mut obj_count = 0;

        for member in archive.members() {
            let member =
                member.map_err(|e| MemInspectError::Archive(e.to_string()))?;
            let name = String::from_utf8_lossy(member.name()).to_string();

            let data = member
                .data(&*file_data)
                .map_err(|e| MemInspectError::Archive(e.to_string()))?;

            // Try to parse as an object file
            match object::File::parse(data) {
                Ok(obj) => {
                    trace!("Parsing DWARF from: {}", name);
                    if let Err(e) = parse_object_dwarf(&obj, &mut info, options.pointer_size) {
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
fn parse_object_dwarf(
    obj: &object::File,
    info: &mut FirmwareInfo,
    pointer_size: usize,
) -> Result<(), String> {
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
        let type_map = build_type_map(&dwarf, &unit, pointer_size)?;

        // Second pass: extract named enums, structs, and variables
        extract_entries(&dwarf, &unit, &type_map, info)?;
    }

    Ok(())
}

// ============================================================
// Type resolution
// ============================================================

/// Parsed layout of a single struct/union member.
///
/// Captures bitfield attributes when present so the byte-decode path can
/// extract the correct bits instead of mis-reading the containing storage.
#[derive(Debug, Clone)]
struct MemberDef {
    name: String,
    /// Byte offset of the member from the start of the aggregate.
    offset: usize,
    /// Reference to the member's declared type.
    type_offset: UnitOffset,
    /// `DW_AT_bit_size`: present only for bitfield members.
    bit_size: Option<u64>,
    /// `DW_AT_data_bit_offset`: bit offset of the field from the start of the
    /// aggregate's allocation for this member (DWARF v4+ form).
    data_bit_offset: Option<u64>,
}

/// Intermediate type representation during parsing.
#[derive(Debug, Clone)]
enum DwarfType {
    Base {
        name: String,
        byte_size: usize,
        signed: bool,
    },
    Float {
        name: String,
        byte_size: usize,
    },
    Enum {
        typedef_name: Option<String>,
        byte_size: usize,
        variants: Vec<(String, i64)>,
    },
    Struct {
        typedef_name: Option<String>,
        byte_size: usize,
        fields: Vec<MemberDef>,
    },
    /// A `union` — like a struct, but every member is laid out at offset 0.
    Union {
        typedef_name: Option<String>,
        byte_size: usize,
        fields: Vec<MemberDef>,
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
    pointer_size: usize,
) -> Result<HashMap<UnitOffset, DwarfType>, String> {
    let mut map = HashMap::new();
    let mut entries = unit.entries();

    while let Ok(Some((_, entry))) = entries.next_dfs() {
        let offset = entry.offset();

        let dtype = match entry.tag() {
            gimli::DW_TAG_base_type => parse_base_type(dwarf, entry),
            gimli::DW_TAG_enumeration_type => parse_enumeration(dwarf, unit, entry),
            gimli::DW_TAG_structure_type => parse_structure(dwarf, unit, entry),
            gimli::DW_TAG_union_type => parse_union(dwarf, unit, entry),
            gimli::DW_TAG_array_type => parse_array(unit, entry),
            gimli::DW_TAG_typedef => parse_typedef(dwarf, entry),
            gimli::DW_TAG_pointer_type => Some(DwarfType::Pointer {
                byte_size: entry
                    .attr_value(gimli::DW_AT_byte_size)
                    .ok()
                    .flatten()
                    .and_then(|v| attr_to_usize(&v))
                    .unwrap_or(pointer_size), // target pointer size when DWARF omits it
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
                DwarfType::Union { typedef_name, .. } if typedef_name.is_none() => {
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
        Some(DwarfType::Float { name, byte_size }) => TypeInfo::Float {
            name: name.clone(),
            byte_size: *byte_size,
        },
        Some(DwarfType::Enum { typedef_name, byte_size, .. }) => TypeInfo::Enum {
            type_name: typedef_name.clone().unwrap_or_default(),
            byte_size: *byte_size,
        },
        Some(DwarfType::Struct { typedef_name, byte_size, .. }) => TypeInfo::Struct {
            type_name: typedef_name.clone().unwrap_or_default(),
            byte_size: *byte_size,
        },
        Some(DwarfType::Union { typedef_name, byte_size, .. }) => TypeInfo::Union {
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

/// Resolve a single struct/union member into a [`FieldInfo`].
///
/// If the member carries bitfield attributes (`DW_AT_bit_size`), the resulting
/// type is a [`TypeInfo::Bitfield`] that records where the bits live within the
/// underlying storage so the byte-decode path can extract them correctly. The
/// member's signedness is taken from its underlying integer/enum type.
fn member_to_field(
    type_map: &HashMap<UnitOffset, DwarfType>,
    member: &MemberDef,
) -> FieldInfo {
    let resolved = resolve_type(type_map, member.type_offset);

    let type_info = if let Some(bit_size) = member.bit_size {
        let storage_size = resolved.byte_size().max(1);
        let signed = match &resolved {
            TypeInfo::Base { signed, .. } => *signed,
            // Enum bitfields are decoded as their (typically signed) integer.
            TypeInfo::Enum { .. } => true,
            _ => false,
        };
        // DWARF v4+ uses DW_AT_data_bit_offset (from the start of the struct
        // allocation). Normalize it to be relative to the member's byte
        // `offset` (where the decoder reads the storage unit). When absent
        // (older producers) we fall back to 0.
        let bit_offset = member
            .data_bit_offset
            .map(|abs| abs.saturating_sub((member.offset as u64) * 8))
            .unwrap_or(0);
        TypeInfo::Bitfield {
            bit_offset,
            bit_size,
            storage_size,
            signed,
        }
    } else {
        resolved
    };

    FieldInfo {
        name: member.name.clone(),
        offset: member.offset,
        type_info,
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
                            match info.enums.get(&name) {
                                None => {
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
                                // First-definition-wins, but warn on a genuine
                                // conflict (same name, different shape) so a
                                // mismatched ODR violation isn't silent.
                                Some(existing)
                                    if existing.byte_size != *byte_size
                                        || existing.variants.len() != variants.len() =>
                                {
                                    debug!(
                                        "enum '{}' redefined with a different shape \
                                         (kept first: {}B/{} variants, ignored: {}B/{} variants)",
                                        name,
                                        existing.byte_size,
                                        existing.variants.len(),
                                        byte_size,
                                        variants.len()
                                    );
                                }
                                Some(_) => {}
                            }
                        }
                        DwarfType::Struct { byte_size, fields, .. }
                        | DwarfType::Union { byte_size, fields, .. } => {
                            // Unions are stored alongside structs; their members
                            // all sit at offset 0, which is already encoded in
                            // each MemberDef.
                            match info.structs.get(&name) {
                                None => {
                                    let resolved_fields: Vec<FieldInfo> = fields
                                        .iter()
                                        .map(|m| member_to_field(type_map, m))
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
                                // First-definition-wins; warn on a real conflict.
                                Some(existing)
                                    if existing.byte_size != *byte_size
                                        || existing.fields.len() != fields.len() =>
                                {
                                    debug!(
                                        "struct/union '{}' redefined with a different shape \
                                         (kept first: {}B/{} fields, ignored: {}B/{} fields)",
                                        name,
                                        existing.byte_size,
                                        existing.fields.len(),
                                        byte_size,
                                        fields.len()
                                    );
                                }
                                Some(_) => {}
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

    // `float`/`double` (and `_Float*`/`long double`) carry DW_ATE_float. These
    // MUST be decoded with f32/f64::from_le_bytes — reading their bytes as an
    // integer produces garbage for any float telemetry.
    if matches!(encoding, AttributeValue::Encoding(gimli::DW_ATE_float)) {
        return Some(DwarfType::Float { name, byte_size });
    }

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

/// Collect the `DW_TAG_member` children of a struct or union into `MemberDef`s,
/// capturing bitfield attributes (`DW_AT_bit_size` / `DW_AT_data_bit_offset`)
/// when present. Shared by [`parse_structure`] and [`parse_union`].
fn collect_members(
    dwarf: &Dwarf<GimliReader>,
    unit: &Unit<GimliReader>,
    entry: &DebuggingInformationEntry<GimliReader>,
) -> Vec<MemberDef> {
    let mut fields = Vec::new();
    let mut tree = match unit.entries_tree(Some(entry.offset())) {
        Ok(t) => t,
        Err(_) => return fields,
    };
    let root = match tree.root() {
        Ok(r) => r,
        Err(_) => return fields,
    };
    let mut children = root.children();
    while let Ok(Some(child)) = children.next() {
        let child_entry = child.entry();
        if child_entry.tag() != gimli::DW_TAG_member {
            continue;
        }
        let name = get_name(dwarf, child_entry).unwrap_or_default();
        // Union members have no DW_AT_data_member_location and sit at offset 0.
        let offset = child_entry
            .attr_value(gimli::DW_AT_data_member_location)
            .ok()
            .flatten()
            .and_then(|v| attr_to_usize(&v))
            .unwrap_or(0);
        let type_offset = get_type_ref(child_entry).unwrap_or(UnitOffset(0));
        let bit_size = child_entry
            .attr_value(gimli::DW_AT_bit_size)
            .ok()
            .flatten()
            .and_then(|v| attr_to_usize(&v))
            .map(|n| n as u64);
        let data_bit_offset = child_entry
            .attr_value(gimli::DW_AT_data_bit_offset)
            .ok()
            .flatten()
            .and_then(|v| attr_to_usize(&v))
            .map(|n| n as u64);
        fields.push(MemberDef {
            name,
            offset,
            type_offset,
            bit_size,
            data_bit_offset,
        });
    }
    fields
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

    Some(DwarfType::Struct {
        typedef_name: None,
        byte_size,
        fields: collect_members(dwarf, unit, entry),
    })
}

fn parse_union(
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

    Some(DwarfType::Union {
        typedef_name: None,
        byte_size,
        fields: collect_members(dwarf, unit, entry),
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
