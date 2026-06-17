//! Type definitions for firmware introspection data.

use std::collections::HashMap;

/// Options controlling how a firmware archive is parsed.
///
/// Defaults match a 64-bit host build with the common `_COUNT` channel-count
/// convention; override for other targets/conventions via
/// [`FirmwareInfo::from_archive_with`].
#[derive(Debug, Clone)]
pub struct ParseOptions {
    /// Pointer size in bytes for the target (used when DWARF omits it). Default 8.
    pub pointer_size: usize,
    /// Suffix of the "count" enum variant looked up by [`FirmwareInfo::channel_count`]
    /// (e.g. `HAL_GPIO_channel_COUNT`). Default `"_COUNT"`.
    pub count_suffix: String,
}

impl Default for ParseOptions {
    fn default() -> Self {
        Self { pointer_size: 8, count_suffix: "_COUNT".to_string() }
    }
}

/// Errors raised while parsing a firmware archive.
#[derive(Debug)]
pub enum MemInspectError {
    /// The archive file could not be read.
    Io(std::io::Error),
    /// The bytes are not a valid `ar` archive.
    Archive(String),
}

impl std::fmt::Display for MemInspectError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            MemInspectError::Io(e) => write!(f, "failed to read firmware archive: {e}"),
            MemInspectError::Archive(e) => write!(f, "failed to parse firmware archive: {e}"),
        }
    }
}

impl std::error::Error for MemInspectError {}

/// Complete firmware debug info parsed from DWARF.
#[derive(Debug, Clone)]
pub struct FirmwareInfo {
    /// All enum types: type_name → EnumInfo
    pub enums: HashMap<String, EnumInfo>,
    /// All enum variants flattened: variant_name → (type_name, value)
    /// This allows O(1) lookup of any enum variant by name.
    pub enum_variants: HashMap<String, (String, i64)>,
    /// All struct types: type_name → StructInfo
    pub structs: HashMap<String, StructInfo>,
    /// All variables: variable_name → VariableInfo
    pub variables: HashMap<String, VariableInfo>,
    /// Channel-count variant suffix convention (default `"_COUNT"`).
    pub count_suffix: String,
}

/// A C enum type with its named variants.
#[derive(Debug, Clone)]
pub struct EnumInfo {
    /// The typedef name (e.g., "HAL_GPIO_channel_E")
    pub name: String,
    /// Size in bytes (typically 4 for unsigned int)
    pub byte_size: usize,
    /// Ordered list of variants (preserves declaration order)
    pub variants: Vec<(String, i64)>,
}

/// A C struct type with its fields and layout.
#[derive(Debug, Clone)]
pub struct StructInfo {
    /// The typedef name (e.g., "dev_cogManager_data_S")
    pub name: String,
    /// Total size in bytes
    pub byte_size: usize,
    /// Fields in declaration order: name → FieldInfo
    pub fields: Vec<FieldInfo>,
}

/// A single struct field with its offset and type.
#[derive(Debug, Clone)]
pub struct FieldInfo {
    /// Field name (e.g., "channels", "state", "lock")
    pub name: String,
    /// Byte offset from struct start
    pub offset: usize,
    /// Type information
    pub type_info: TypeInfo,
}

/// Type information for a field or variable.
#[derive(Debug, Clone)]
pub enum TypeInfo {
    /// Primitive integer/bool/char type (int, uint8_t, bool, etc.)
    Base {
        name: String,
        byte_size: usize,
        signed: bool,
    },
    /// IEEE-754 floating point type (`float` = 4 bytes, `double` = 8 bytes).
    ///
    /// Decoded with `f32::from_le_bytes` / `f64::from_le_bytes` rather than as
    /// an integer — decoding float bytes as an integer yields garbage.
    Float {
        name: String,
        byte_size: usize,
    },
    /// Enum type (stored as integer)
    Enum {
        type_name: String,
        byte_size: usize,
    },
    /// Struct type
    Struct {
        type_name: String,
        byte_size: usize,
    },
    /// Union type (all members share offset 0).
    ///
    /// Stored alongside structs in `FirmwareInfo::structs`; field offsets are
    /// all `0`. Treated like a struct for field-path resolution.
    Union {
        type_name: String,
        byte_size: usize,
    },
    /// A C bitfield member: a sub-byte run of bits within an underlying
    /// integer storage unit.
    ///
    /// - `bit_offset` is the offset, in bits, from the start of the field's
    ///   storage (`DW_AT_data_bit_offset`, which is measured from the start of
    ///   the containing struct's allocation for this member — see decode).
    /// - `bit_size` is the width of the bitfield in bits (`DW_AT_bit_size`).
    /// - `storage_size` is the byte size of the underlying integer type.
    /// - `signed` indicates whether the underlying type is signed (sign-extend
    ///   on decode).
    Bitfield {
        bit_offset: u64,
        bit_size: u64,
        storage_size: usize,
        signed: bool,
    },
    /// Fixed-size array
    Array {
        element_type: Box<TypeInfo>,
        count: usize,
    },
    /// Pointer type
    Pointer {
        byte_size: usize,
    },
    /// Unknown / unsupported type
    Unknown {
        byte_size: usize,
    },
}

impl TypeInfo {
    /// Get the byte size of this type.
    ///
    /// For a [`TypeInfo::Bitfield`] this returns the size of the underlying
    /// integer storage unit (the number of bytes that must be read to extract
    /// the bitfield), not the bit width.
    pub fn byte_size(&self) -> usize {
        match self {
            TypeInfo::Base { byte_size, .. } => *byte_size,
            TypeInfo::Float { byte_size, .. } => *byte_size,
            TypeInfo::Enum { byte_size, .. } => *byte_size,
            TypeInfo::Struct { byte_size, .. } => *byte_size,
            TypeInfo::Union { byte_size, .. } => *byte_size,
            TypeInfo::Bitfield { storage_size, .. } => *storage_size,
            TypeInfo::Array { element_type, count } => element_type.byte_size() * count,
            TypeInfo::Pointer { byte_size } => *byte_size,
            TypeInfo::Unknown { byte_size } => *byte_size,
        }
    }
}

/// Information about a C variable (global or static).
#[derive(Debug, Clone)]
pub struct VariableInfo {
    /// Variable name (e.g., "dev_cogManager_data")
    pub name: String,
    /// Type information
    pub type_info: TypeInfo,
    /// Source file where defined
    pub source_file: Option<String>,
}

// ============================================================
// FirmwareInfo API
// ============================================================

impl FirmwareInfo {
    /// Create an empty FirmwareInfo with the default `"_COUNT"` convention.
    pub fn new() -> Self {
        Self {
            enums: HashMap::new(),
            enum_variants: HashMap::new(),
            structs: HashMap::new(),
            variables: HashMap::new(),
            count_suffix: "_COUNT".to_string(),
        }
    }

    // ── Fallible lookups ──
    //
    // The enum/struct/variable names differ between firmware projects, so a
    // new consumer needs to *probe* for symbols (and report all that are
    // missing) rather than crash one panic at a time. The `try_*` methods
    // return `Option`; the original methods below are thin panicking wrappers
    // for call sites that have already validated the symbol exists.

    /// `true` if an enum *variant* with this name exists.
    pub fn has_enum_variant(&self, variant_name: &str) -> bool {
        self.enum_variants.contains_key(variant_name)
    }

    /// `true` if an enum *type* with this name exists.
    pub fn has_enum_type(&self, type_name: &str) -> bool {
        self.enums.contains_key(type_name)
    }

    /// Look up an enum variant value by name, or `None` if absent.
    pub fn try_enum_value(&self, variant_name: &str) -> Option<i64> {
        self.enum_variants.get(variant_name).map(|(_, v)| *v)
    }

    /// Look up an enum variant value as `usize`, or `None` if absent.
    pub fn try_enum_channel(&self, variant_name: &str) -> Option<usize> {
        self.try_enum_value(variant_name).map(|v| v as usize)
    }

    /// Get all variants of a named enum type, or `None` if absent.
    pub fn try_enum_variants(&self, type_name: &str) -> Option<&[(String, i64)]> {
        self.enums.get(type_name).map(|e| e.variants.as_slice())
    }

    /// Get the count variant of an enum type (the variant whose name ends with
    /// [`count_suffix`](FirmwareInfo::count_suffix), default `"_COUNT"`), or
    /// `None` if the type is absent or has no such variant.
    pub fn try_channel_count(&self, type_name: &str) -> Option<usize> {
        let suffix = &self.count_suffix;
        self.enums.get(type_name).and_then(|info| {
            info.variants
                .iter()
                .find(|(name, _)| name.ends_with(suffix.as_str()))
                .map(|(_, v)| *v as usize)
        })
    }

    /// Look up an enum variant value by name. Panics if not found.
    ///
    /// ```rust,ignore
    /// let val = fw.enum_value("HAL_GPIO_SERVO_ENA"); // e.g. 0i64
    /// ```
    pub fn enum_value(&self, variant_name: &str) -> i64 {
        self.try_enum_value(variant_name)
            .unwrap_or_else(|| panic!("Firmware enum variant '{}' not found in DWARF debug info", variant_name))
    }

    /// Look up an enum variant value as `usize` (for channel indices). Panics if not found.
    ///
    /// ```rust,ignore
    /// let pin = fw.enum_channel("HAL_GPIO_SERVO_ENA");
    /// ```
    pub fn enum_channel(&self, variant_name: &str) -> usize {
        self.enum_value(variant_name) as usize
    }

    /// MCU-neutral alias for [`enum_channel`](Self::enum_channel): look up an
    /// enum variant's value as `usize` (e.g. a peripheral channel index).
    pub fn enum_value_usize(&self, variant_name: &str) -> usize {
        self.enum_channel(variant_name)
    }

    /// Get all variants of a named enum type. Panics if not found.
    pub fn enum_variants(&self, type_name: &str) -> &[(String, i64)] {
        self.try_enum_variants(type_name)
            .unwrap_or_else(|| panic!("Firmware enum type '{}' not found in DWARF debug info", type_name))
    }

    /// Get the `_COUNT` variant of an enum type (by convention). Panics if not found.
    ///
    /// ```rust,ignore
    /// let count = fw.channel_count("HAL_GPIO_channel_E");
    /// ```
    pub fn channel_count(&self, type_name: &str) -> usize {
        if !self.has_enum_type(type_name) {
            panic!("Firmware enum type '{}' not found in DWARF debug info", type_name);
        }
        self.try_channel_count(type_name)
            .unwrap_or_else(|| panic!("Firmware enum type '{}' has no _COUNT variant", type_name))
    }

    /// Get struct layout by type name, or `None` if absent.
    pub fn try_struct_info(&self, type_name: &str) -> Option<&StructInfo> {
        self.structs.get(type_name)
    }

    /// Get struct layout by type name. Panics if not found.
    pub fn struct_info(&self, type_name: &str) -> &StructInfo {
        self.try_struct_info(type_name)
            .unwrap_or_else(|| panic!("Firmware struct type '{}' not found in DWARF debug info", type_name))
    }

    /// Resolve a field path to a byte offset within a struct type, or `None` if
    /// the type or field path is absent.
    pub fn try_field_offset(&self, type_name: &str, path: &str) -> Option<usize> {
        let struct_info = self.structs.get(type_name)?;
        self.resolve_field_offset(struct_info, path)
    }

    /// Resolve a field path to a byte offset within a struct type. Panics if not found.
    ///
    /// Supports dotted paths and array indices:
    /// - `"state"` → offset of the `state` field
    /// - `"channels[0].state"` → offset of first element's `state` field
    /// - `"channels[2].output.running"` → nested field access
    pub fn field_offset(&self, type_name: &str, path: &str) -> usize {
        if !self.structs.contains_key(type_name) {
            panic!("Firmware struct type '{}' not found in DWARF debug info", type_name);
        }
        self.try_field_offset(type_name, path)
            .unwrap_or_else(|| panic!("Field path '{}' not found in struct '{}'", path, type_name))
    }

    /// Internal: resolve a field path to byte offset.
    pub(crate) fn resolve_field_offset(&self, struct_info: &StructInfo, path: &str) -> Option<usize> {
        let (first, rest) = split_path(path);
        let (field_name, array_index) = parse_array_access(first);

        // Find the field
        let field = struct_info.fields.iter().find(|f| f.name == field_name)?;
        let mut offset = field.offset;

        // Handle array indexing
        let field_type = if let Some(idx) = array_index {
            if let TypeInfo::Array { element_type, count } = &field.type_info {
                if idx >= *count {
                    return None; // Out of bounds
                }
                offset += idx * element_type.byte_size();
                element_type.as_ref()
            } else {
                return None; // Not an array
            }
        } else {
            &field.type_info
        };

        // If there's more path to resolve, recurse into the struct/union type
        if let Some(remaining) = rest {
            match field_type {
                TypeInfo::Struct { type_name, .. } | TypeInfo::Union { type_name, .. } => {
                    let nested = self.structs.get(type_name)?;
                    let nested_offset = self.resolve_field_offset(nested, remaining)?;
                    Some(offset + nested_offset)
                }
                _ => None, // Can't descend into non-struct/non-union
            }
        } else {
            Some(offset)
        }
    }

    /// Get the type of a field at the given path. Panics if not found.
    pub fn field_type(&self, type_name: &str, path: &str) -> &TypeInfo {
        let struct_info = self.structs.get(type_name)
            .unwrap_or_else(|| panic!("Firmware struct type '{}' not found in DWARF debug info", type_name));
        self.resolve_field_type(struct_info, path)
            .unwrap_or_else(|| panic!("Field path '{}' not found in struct '{}'", path, type_name))
    }

    pub(crate) fn resolve_field_type<'a>(&'a self, struct_info: &'a StructInfo, path: &str) -> Option<&'a TypeInfo> {
        let (first, rest) = split_path(path);
        let (field_name, array_index) = parse_array_access(first);

        let field = struct_info.fields.iter().find(|f| f.name == field_name)?;

        let field_type = if let Some(_idx) = array_index {
            if let TypeInfo::Array { element_type, .. } = &field.type_info {
                element_type.as_ref()
            } else {
                return None;
            }
        } else {
            &field.type_info
        };

        if let Some(remaining) = rest {
            match field_type {
                TypeInfo::Struct { type_name, .. } | TypeInfo::Union { type_name, .. } => {
                    let nested = self.structs.get(type_name)?;
                    self.resolve_field_type(nested, remaining)
                }
                _ => None,
            }
        } else {
            Some(field_type)
        }
    }
}

impl Default for FirmwareInfo {
    fn default() -> Self {
        Self::new()
    }
}

// ============================================================
// Path parsing helpers
// ============================================================

/// Split "channels[0].state" into ("channels[0]", Some("state"))
/// Split "state" into ("state", None)
fn split_path(path: &str) -> (&str, Option<&str>) {
    // Find the first '.' that isn't inside brackets
    let mut bracket_depth = 0;
    for (i, ch) in path.char_indices() {
        match ch {
            '[' => bracket_depth += 1,
            ']' => bracket_depth -= 1,
            '.' if bracket_depth == 0 => {
                return (&path[..i], Some(&path[i + 1..]));
            }
            _ => {}
        }
    }
    (path, None)
}

/// Parse "channels[2]" into ("channels", Some(2))
/// Parse "state" into ("state", None)
fn parse_array_access(field: &str) -> (&str, Option<usize>) {
    if let Some(bracket_pos) = field.find('[') {
        let name = &field[..bracket_pos];
        let idx_str = &field[bracket_pos + 1..field.len() - 1]; // strip [ and ]
        let idx = idx_str.parse::<usize>().ok();
        (name, idx)
    } else {
        (field, None)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_split_path() {
        assert_eq!(split_path("state"), ("state", None));
        assert_eq!(split_path("channels[0].state"), ("channels[0]", Some("state")));
        assert_eq!(split_path("a.b.c"), ("a", Some("b.c")));
    }

    #[test]
    fn test_parse_array_access() {
        assert_eq!(parse_array_access("channels"), ("channels", None));
        assert_eq!(parse_array_access("channels[0]"), ("channels", Some(0)));
        assert_eq!(parse_array_access("channels[42]"), ("channels", Some(42)));
    }

    fn sample_fw() -> FirmwareInfo {
        let mut fw = FirmwareInfo::new();
        fw.enums.insert(
            "HAL_GPIO_channel_E".to_string(),
            EnumInfo {
                name: "HAL_GPIO_channel_E".to_string(),
                byte_size: 4,
                variants: vec![
                    ("HAL_GPIO_SERVO_ENA".to_string(), 0),
                    ("HAL_GPIO_SERVO_DIR".to_string(), 1),
                    ("HAL_GPIO_channel_COUNT".to_string(), 2),
                ],
            },
        );
        fw.enum_variants.insert("HAL_GPIO_SERVO_ENA".to_string(), ("HAL_GPIO_channel_E".to_string(), 0));
        fw.enum_variants.insert("HAL_GPIO_SERVO_DIR".to_string(), ("HAL_GPIO_channel_E".to_string(), 1));
        fw.enum_variants.insert("HAL_GPIO_channel_COUNT".to_string(), ("HAL_GPIO_channel_E".to_string(), 2));
        fw
    }

    #[test]
    fn try_lookups_return_none_for_missing() {
        let fw = sample_fw();
        // Present
        assert_eq!(fw.try_enum_value("HAL_GPIO_SERVO_DIR"), Some(1));
        assert_eq!(fw.try_enum_channel("HAL_GPIO_SERVO_DIR"), Some(1));
        assert_eq!(fw.try_channel_count("HAL_GPIO_channel_E"), Some(2));
        assert!(fw.has_enum_variant("HAL_GPIO_SERVO_ENA"));
        assert!(fw.has_enum_type("HAL_GPIO_channel_E"));
        // Absent
        assert_eq!(fw.try_enum_value("HAL_GPIO_NOPE"), None);
        assert_eq!(fw.try_channel_count("Nonexistent_E"), None);
        assert!(!fw.has_enum_variant("HAL_GPIO_NOPE"));
        assert!(!fw.has_enum_type("Nonexistent_E"));
    }

    #[test]
    fn panicking_wrappers_agree_with_try() {
        let fw = sample_fw();
        assert_eq!(fw.enum_channel("HAL_GPIO_SERVO_DIR"), 1);
        assert_eq!(fw.channel_count("HAL_GPIO_channel_E"), 2);
        assert_eq!(fw.enum_variants("HAL_GPIO_channel_E").len(), 3);
    }

    // ── Path parsing additional cases ──

    /// `split_path` handles dots inside bracketed indices and trailing segments.
    #[test]
    fn split_path_extra_cases() {
        // A dot inside brackets does not split (no array literals use it here,
        // but the depth guard must still hold for the bracket scan).
        assert_eq!(split_path("channels[2].output.running"), ("channels[2]", Some("output.running")));
        // Bare index with no trailing field.
        assert_eq!(split_path("channels[2]"), ("channels[2]", None));
        // Empty string is its own first segment.
        assert_eq!(split_path(""), ("", None));
        // Leading dot yields an empty first segment.
        assert_eq!(split_path(".rest"), ("", Some("rest")));
    }

    /// `parse_array_access` parses indices, including zero and large values, and
    /// returns `None` for a non-numeric index.
    #[test]
    fn parse_array_access_extra_cases() {
        assert_eq!(parse_array_access("x[0]"), ("x", Some(0)));
        assert_eq!(parse_array_access("x[12345]"), ("x", Some(12345)));
        // Non-numeric index → name with None (the parse fails).
        assert_eq!(parse_array_access("x[abc]"), ("x", None));
    }

    // ── byte_size() for EVERY TypeInfo variant ──

    /// [`TypeInfo::byte_size`] returns the right size for every variant, with
    /// `Array` multiplying element size by count and `Bitfield` returning the
    /// storage unit size (not the bit width).
    #[test]
    fn byte_size_covers_every_variant() {
        assert_eq!(TypeInfo::Base { name: "i".into(), byte_size: 4, signed: true }.byte_size(), 4);
        assert_eq!(TypeInfo::Float { name: "f".into(), byte_size: 8 }.byte_size(), 8);
        assert_eq!(TypeInfo::Enum { type_name: "E".into(), byte_size: 2 }.byte_size(), 2);
        assert_eq!(TypeInfo::Struct { type_name: "S".into(), byte_size: 16 }.byte_size(), 16);
        assert_eq!(TypeInfo::Union { type_name: "U".into(), byte_size: 8 }.byte_size(), 8);
        // Bitfield returns the storage unit size, regardless of bit width.
        assert_eq!(
            TypeInfo::Bitfield { bit_offset: 0, bit_size: 3, storage_size: 1, signed: false }.byte_size(),
            1
        );
        // Array: element size (4) × count (5) = 20.
        let arr = TypeInfo::Array {
            element_type: Box::new(TypeInfo::Base { name: "i".into(), byte_size: 4, signed: true }),
            count: 5,
        };
        assert_eq!(arr.byte_size(), 20);
        // Nested array-of-arrays multiplies through.
        let nested = TypeInfo::Array {
            element_type: Box::new(arr),
            count: 2,
        };
        assert_eq!(nested.byte_size(), 40);
        assert_eq!(TypeInfo::Pointer { byte_size: 8 }.byte_size(), 8);
        assert_eq!(TypeInfo::Unknown { byte_size: 0 }.byte_size(), 0);
    }

    // ── resolve_field_offset / resolve_field_type via a hand-built struct map ──

    /// A small firmware model with a nested struct, an array of structs, and a
    /// union, used to drive field-path resolution without a real archive.
    fn layout_fw() -> FirmwareInfo {
        let mut fw = FirmwareInfo::new();

        // inner_S { uint8_t a; uint8_t b; } size 2
        fw.structs.insert(
            "inner_S".to_string(),
            StructInfo {
                name: "inner_S".to_string(),
                byte_size: 2,
                fields: vec![
                    FieldInfo { name: "a".into(), offset: 0, type_info: TypeInfo::Base { name: "u8".into(), byte_size: 1, signed: false } },
                    FieldInfo { name: "b".into(), offset: 1, type_info: TypeInfo::Base { name: "u8".into(), byte_size: 1, signed: false } },
                ],
            },
        );

        // conv_U union: raw @0, as_f @0, both 4 bytes
        fw.structs.insert(
            "conv_U".to_string(),
            StructInfo {
                name: "conv_U".to_string(),
                byte_size: 4,
                fields: vec![
                    FieldInfo { name: "raw".into(), offset: 0, type_info: TypeInfo::Base { name: "u32".into(), byte_size: 4, signed: false } },
                    FieldInfo { name: "as_f".into(), offset: 0, type_info: TypeInfo::Float { name: "float".into(), byte_size: 4 } },
                ],
            },
        );

        // outer_S {
        //   inner_S nested;                 @0
        //   inner_S arr[3];                 @2   (element size 2)
        //   conv_U conv;                    @8
        //   int32_t flat;                   @12
        // }
        fw.structs.insert(
            "outer_S".to_string(),
            StructInfo {
                name: "outer_S".to_string(),
                byte_size: 16,
                fields: vec![
                    FieldInfo { name: "nested".into(), offset: 0, type_info: TypeInfo::Struct { type_name: "inner_S".into(), byte_size: 2 } },
                    FieldInfo {
                        name: "arr".into(),
                        offset: 2,
                        type_info: TypeInfo::Array {
                            element_type: Box::new(TypeInfo::Struct { type_name: "inner_S".into(), byte_size: 2 }),
                            count: 3,
                        },
                    },
                    FieldInfo { name: "conv".into(), offset: 8, type_info: TypeInfo::Union { type_name: "conv_U".into(), byte_size: 4 } },
                    FieldInfo { name: "flat".into(), offset: 12, type_info: TypeInfo::Base { name: "i32".into(), byte_size: 4, signed: true } },
                ],
            },
        );
        fw
    }

    /// Nested-struct, array-index, and union field paths resolve to the right
    /// byte offsets.
    #[test]
    fn resolve_field_offset_paths() {
        let fw = layout_fw();

        // Flat field at the top level.
        assert_eq!(fw.field_offset("outer_S", "flat"), 12);

        // Nested struct path: nested(@0) + b(@1) = 1.
        assert_eq!(fw.field_offset("outer_S", "nested.a"), 0);
        assert_eq!(fw.field_offset("outer_S", "nested.b"), 1);

        // Array index: arr(@2) + idx*elem_size(2) + a(@0).
        assert_eq!(fw.field_offset("outer_S", "arr[0].a"), 2);
        assert_eq!(fw.field_offset("outer_S", "arr[1].a"), 4);
        assert_eq!(fw.field_offset("outer_S", "arr[2].b"), 7);

        // Union: every member sits at the same offset (conv @8).
        assert_eq!(fw.field_offset("outer_S", "conv.raw"), 8);
        assert_eq!(fw.field_offset("outer_S", "conv.as_f"), 8);
        assert_eq!(
            fw.field_offset("outer_S", "conv.raw"),
            fw.field_offset("outer_S", "conv.as_f")
        );
    }

    /// Field-path resolution returns `None` for out-of-bounds indices, indexing
    /// a non-array, descending into a non-struct, and missing field names.
    #[test]
    fn resolve_field_offset_none_paths() {
        let fw = layout_fw();

        // Out-of-bounds array index (arr has 3 elements).
        assert_eq!(fw.try_field_offset("outer_S", "arr[3].a"), None);
        assert_eq!(fw.try_field_offset("outer_S", "arr[99].a"), None);

        // Indexing a non-array field.
        assert_eq!(fw.try_field_offset("outer_S", "flat[0]"), None);

        // Descending into a non-struct/non-union leaf (flat is an int).
        assert_eq!(fw.try_field_offset("outer_S", "flat.x"), None);

        // Missing field name.
        assert_eq!(fw.try_field_offset("outer_S", "does_not_exist"), None);

        // Missing nested field name.
        assert_eq!(fw.try_field_offset("outer_S", "nested.zzz"), None);

        // Missing struct type entirely.
        assert_eq!(fw.try_field_offset("Nonexistent_S", "flat"), None);
    }

    /// `resolve_field_type` yields the correct leaf type for each path shape.
    #[test]
    fn resolve_field_type_paths() {
        let fw = layout_fw();

        match fw.field_type("outer_S", "flat") {
            TypeInfo::Base { signed, byte_size, .. } => {
                assert!(*signed);
                assert_eq!(*byte_size, 4);
            }
            other => panic!("flat should be a signed Base, got {other:?}"),
        }

        match fw.field_type("outer_S", "nested.a") {
            TypeInfo::Base { byte_size, signed, .. } => {
                assert_eq!(*byte_size, 1);
                assert!(!*signed);
            }
            other => panic!("nested.a should be u8 Base, got {other:?}"),
        }

        // Array element field type strips the array.
        match fw.field_type("outer_S", "arr[1].b") {
            TypeInfo::Base { byte_size, .. } => assert_eq!(*byte_size, 1),
            other => panic!("arr[1].b should be a Base, got {other:?}"),
        }

        // Union member type.
        match fw.field_type("outer_S", "conv.as_f") {
            TypeInfo::Float { byte_size, .. } => assert_eq!(*byte_size, 4),
            other => panic!("conv.as_f should be Float, got {other:?}"),
        }

        // try variants for missing paths.
        assert!(fw
            .resolve_field_type(fw.struct_info("outer_S"), "nope")
            .is_none());
    }

    // ── Panicking wrappers panic on missing; try_* return None ──

    /// `field_offset` panics when the struct type is missing.
    #[test]
    #[should_panic(expected = "not found")]
    fn field_offset_panics_on_missing_type() {
        let fw = layout_fw();
        fw.field_offset("Nonexistent_S", "flat");
    }

    /// `field_offset` panics when the field path is missing.
    #[test]
    #[should_panic(expected = "not found")]
    fn field_offset_panics_on_missing_path() {
        let fw = layout_fw();
        fw.field_offset("outer_S", "no_such_field");
    }

    /// `field_type` panics when the struct type is missing.
    #[test]
    #[should_panic(expected = "not found")]
    fn field_type_panics_on_missing_type() {
        let fw = layout_fw();
        fw.field_type("Nonexistent_S", "flat");
    }

    /// `field_type` panics when the field path is missing.
    #[test]
    #[should_panic(expected = "not found")]
    fn field_type_panics_on_missing_path() {
        let fw = layout_fw();
        fw.field_type("outer_S", "no_such_field");
    }

    /// `struct_info` panics on a missing type; `try_struct_info` returns None.
    #[test]
    #[should_panic(expected = "not found")]
    fn struct_info_panics_on_missing() {
        let fw = layout_fw();
        fw.struct_info("Nonexistent_S");
    }

    /// `enum_value` panics on a missing variant.
    #[test]
    #[should_panic(expected = "not found")]
    fn enum_value_panics_on_missing() {
        let fw = sample_fw();
        fw.enum_value("HAL_GPIO_NOPE");
    }

    /// `enum_variants` panics on a missing enum type.
    #[test]
    #[should_panic(expected = "not found")]
    fn enum_variants_panics_on_missing() {
        let fw = sample_fw();
        fw.enum_variants("Nonexistent_E");
    }

    /// `channel_count` panics when the enum type is missing.
    #[test]
    #[should_panic(expected = "not found")]
    fn channel_count_panics_on_missing_type() {
        let fw = sample_fw();
        fw.channel_count("Nonexistent_E");
    }

    /// `channel_count` panics when the enum exists but has no `_COUNT` variant.
    #[test]
    #[should_panic(expected = "_COUNT")]
    fn channel_count_panics_without_count_variant() {
        let mut fw = FirmwareInfo::new();
        fw.enums.insert(
            "NoCount_E".to_string(),
            EnumInfo {
                name: "NoCount_E".to_string(),
                byte_size: 4,
                variants: vec![("ONLY".to_string(), 0)],
            },
        );
        fw.channel_count("NoCount_E");
    }

    // ── Default impls, aliases, error Display ──

    /// `FirmwareInfo::default` and `ParseOptions::default` produce the documented
    /// defaults.
    #[test]
    fn defaults_are_sane() {
        let fw = FirmwareInfo::default();
        assert!(fw.enums.is_empty());
        assert!(fw.structs.is_empty());
        assert!(fw.variables.is_empty());
        assert_eq!(fw.count_suffix, "_COUNT");

        let opts = ParseOptions::default();
        assert_eq!(opts.pointer_size, 8);
        assert_eq!(opts.count_suffix, "_COUNT");
    }

    /// `enum_value_usize` is an alias for `enum_channel`.
    #[test]
    fn enum_value_usize_alias() {
        let fw = sample_fw();
        assert_eq!(fw.enum_value_usize("HAL_GPIO_SERVO_DIR"), fw.enum_channel("HAL_GPIO_SERVO_DIR"));
        assert_eq!(fw.enum_value_usize("HAL_GPIO_SERVO_DIR"), 1);
    }

    /// `try_enum_variants` returns the slice for a present type and `None` for
    /// an absent one.
    #[test]
    fn try_enum_variants_present_and_absent() {
        let fw = sample_fw();
        assert_eq!(fw.try_enum_variants("HAL_GPIO_channel_E").map(|v| v.len()), Some(3));
        assert!(fw.try_enum_variants("Nonexistent_E").is_none());
    }

    /// `MemInspectError` Display renders both variants with a readable message.
    #[test]
    fn meminspect_error_display() {
        let io = MemInspectError::Io(std::io::Error::new(std::io::ErrorKind::NotFound, "boom"));
        let s = io.to_string();
        assert!(s.contains("failed to read firmware archive"), "got: {s}");
        assert!(s.contains("boom"), "got: {s}");

        let arch = MemInspectError::Archive("bad magic".to_string());
        let s = arch.to_string();
        assert!(s.contains("failed to parse firmware archive"), "got: {s}");
        assert!(s.contains("bad magic"), "got: {s}");
    }
}
