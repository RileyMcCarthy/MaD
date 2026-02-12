//! Type definitions for firmware introspection data.

use std::collections::HashMap;

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
    /// Primitive type (int, uint8_t, bool, etc.)
    Base {
        name: String,
        byte_size: usize,
        signed: bool,
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
    pub fn byte_size(&self) -> usize {
        match self {
            TypeInfo::Base { byte_size, .. } => *byte_size,
            TypeInfo::Enum { byte_size, .. } => *byte_size,
            TypeInfo::Struct { byte_size, .. } => *byte_size,
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
    /// Create an empty FirmwareInfo.
    pub fn new() -> Self {
        Self {
            enums: HashMap::new(),
            enum_variants: HashMap::new(),
            structs: HashMap::new(),
            variables: HashMap::new(),
        }
    }

    /// Look up an enum variant value by name. Panics if not found.
    ///
    /// ```rust,ignore
    /// let val = fw.enum_value("HAL_GPIO_SERVO_ENA"); // e.g. 0i64
    /// ```
    pub fn enum_value(&self, variant_name: &str) -> i64 {
        self.enum_variants
            .get(variant_name)
            .unwrap_or_else(|| panic!("Firmware enum variant '{}' not found in DWARF debug info", variant_name))
            .1
    }

    /// Look up an enum variant value as `usize` (for channel indices). Panics if not found.
    ///
    /// ```rust,ignore
    /// let pin = fw.enum_channel("HAL_GPIO_SERVO_ENA");
    /// ```
    pub fn enum_channel(&self, variant_name: &str) -> usize {
        self.enum_value(variant_name) as usize
    }

    /// Get all variants of a named enum type. Panics if not found.
    pub fn enum_variants(&self, type_name: &str) -> &[(String, i64)] {
        self.enums
            .get(type_name)
            .unwrap_or_else(|| panic!("Firmware enum type '{}' not found in DWARF debug info", type_name))
            .variants
            .as_slice()
    }

    /// Get the `_COUNT` variant of an enum type (by convention). Panics if not found.
    ///
    /// ```rust,ignore
    /// let count = fw.channel_count("HAL_GPIO_channel_E");
    /// ```
    pub fn channel_count(&self, type_name: &str) -> usize {
        let info = self.enums
            .get(type_name)
            .unwrap_or_else(|| panic!("Firmware enum type '{}' not found in DWARF debug info", type_name));
        info.variants
            .iter()
            .find(|(name, _)| name.ends_with("_COUNT"))
            .unwrap_or_else(|| panic!("Firmware enum type '{}' has no _COUNT variant", type_name))
            .1 as usize
    }

    /// Get struct layout by type name. Panics if not found.
    pub fn struct_info(&self, type_name: &str) -> &StructInfo {
        self.structs
            .get(type_name)
            .unwrap_or_else(|| panic!("Firmware struct type '{}' not found in DWARF debug info", type_name))
    }

    /// Resolve a field path to a byte offset within a struct type. Panics if not found.
    ///
    /// Supports dotted paths and array indices:
    /// - `"state"` → offset of the `state` field
    /// - `"channels[0].state"` → offset of first element's `state` field
    /// - `"channels[2].output.running"` → nested field access
    pub fn field_offset(&self, type_name: &str, path: &str) -> usize {
        let struct_info = self.structs.get(type_name)
            .unwrap_or_else(|| panic!("Firmware struct type '{}' not found in DWARF debug info", type_name));
        self.resolve_field_offset(struct_info, path)
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

        // If there's more path to resolve, recurse into the struct type
        if let Some(remaining) = rest {
            match field_type {
                TypeInfo::Struct { type_name, .. } => {
                    let nested = self.structs.get(type_name)?;
                    let nested_offset = self.resolve_field_offset(nested, remaining)?;
                    Some(offset + nested_offset)
                }
                _ => None, // Can't descend into non-struct
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
                TypeInfo::Struct { type_name, .. } => {
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
}
