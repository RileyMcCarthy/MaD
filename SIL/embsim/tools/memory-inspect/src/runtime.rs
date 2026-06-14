//! Runtime symbol resolution and memory reading.
//!
//! Resolves C variable addresses from the running binary's symbol table
//! and reads typed values from firmware memory using DWARF layout info.

use crate::types::{FirmwareInfo, TypeInfo};
use object::{Object, ObjectSymbol};
use std::path::Path;
use tracing::{debug, info, warn};

/// Runtime base address of the main executable's lowest mapping, parsed from
/// `/proc/self/maps` (the load bias of a PIE). Returns `None` if maps cannot be
/// read or the executable's own mapping is not found.
#[cfg(target_os = "linux")]
fn linux_exe_load_base() -> Option<u64> {
    use std::io::BufRead;
    let exe = std::fs::read_link("/proc/self/exe").ok()?;
    let exe = exe.to_str()?;
    let file = std::fs::File::open("/proc/self/maps").ok()?;
    // maps is sorted by address, so the first line whose pathname is the exe is
    // its lowest (base) mapping.
    for line in std::io::BufReader::new(file).lines().map_while(Result::ok) {
        let path = line.split_whitespace().nth(5);
        if path == Some(exe) {
            let base_hex = line.split('-').next()?;
            return u64::from_str_radix(base_hex, 16).ok();
        }
    }
    None
}

/// Resolves symbol addresses from the running binary's Mach-O/ELF symbol table.
pub struct SymbolResolver {
    /// Map of symbol name → virtual address in the binary
    symbols: std::collections::HashMap<String, u64>,
    /// Base address offset (ASLR slide on macOS)
    slide: u64,
}

impl SymbolResolver {
    /// Create a resolver by parsing the current executable's symbol table.
    ///
    /// On macOS, also calculates the ASLR slide so addresses from `nm`
    /// map correctly to runtime memory.
    pub fn new() -> Result<Self, String> {
        let exe_path = std::env::current_exe()
            .map_err(|e| format!("Failed to get current exe path: {}", e))?;

        Self::from_binary(&exe_path)
    }

    /// Create a resolver from a specific binary file.
    pub fn from_binary(path: &Path) -> Result<Self, String> {
        let data = std::fs::read(path)
            .map_err(|e| format!("Failed to read binary {}: {}", path.display(), e))?;

        let obj = object::File::parse(&*data)
            .map_err(|e| format!("Failed to parse binary: {}", e))?;

        let mut symbols = std::collections::HashMap::new();

        for symbol in obj.symbols() {
            if let Ok(name) = symbol.name() {
                // Strip leading underscore on macOS
                let clean_name = name.strip_prefix('_').unwrap_or(name);
                symbols.insert(clean_name.to_string(), symbol.address());
            }
        }

        let slide = Self::compute_slide(&symbols);

        info!(
            "Symbol resolver: {} symbols loaded, slide=0x{:x}",
            symbols.len(),
            slide
        );

        Ok(Self { symbols, slide })
    }

    /// Compute the load bias ("slide") between a symbol's file (link-time)
    /// address and its runtime address in the current process image.
    fn compute_slide(
        _symbols: &std::collections::HashMap<String, u64>,
    ) -> u64 {
        // macOS: ask dyld for the main image's ASLR slide directly.
        #[cfg(target_os = "macos")]
        {
            extern "C" {
                fn _dyld_get_image_vmaddr_slide(image_index: u32) -> isize;
            }
            unsafe { _dyld_get_image_vmaddr_slide(0) as u64 }
        }

        // Linux: the bias of a position-independent executable is the runtime
        // base of its lowest mapping in /proc/self/maps (PIEs link at vaddr 0,
        // so file address + base == runtime address). Non-PIE binaries map at
        // their link address, making the base cancel out to an effective 0
        // because file addresses already match — for those, symbol addresses
        // are absolute and adding this base would be wrong, but modern
        // toolchains default to PIE, which this handles correctly.
        #[cfg(target_os = "linux")]
        {
            linux_exe_load_base().unwrap_or(0)
        }

        #[cfg(not(any(target_os = "macos", target_os = "linux")))]
        {
            0
        }
    }

    /// Get the runtime address of a symbol by name.
    pub fn symbol_address(&self, name: &str) -> Option<*const u8> {
        self.symbols.get(name).map(|&addr| {
            let runtime_addr = addr.wrapping_add(self.slide);
            runtime_addr as *const u8
        })
    }

    /// Read a raw byte slice from a symbol + offset.
    ///
    /// # Safety
    /// The caller must ensure the symbol exists in the running binary
    /// and the offset + len doesn't exceed the variable's storage.
    pub unsafe fn read_bytes(
        &self,
        symbol_name: &str,
        offset: usize,
        len: usize,
    ) -> Option<Vec<u8>> {
        let base = self.symbol_address(symbol_name)?;
        let ptr = base.add(offset);
        let mut buf = vec![0u8; len];
        std::ptr::copy_nonoverlapping(ptr, buf.as_mut_ptr(), len);
        Some(buf)
    }

    /// Read a typed value from a firmware variable's field.
    ///
    /// Uses FirmwareInfo to resolve the field path to an offset,
    /// then reads the appropriate number of bytes and interprets them.
    ///
    /// # Example
    /// ```rust,ignore
    /// let state: i32 = unsafe {
    ///     resolver.read_field(&fw, "dev_cogManager_data", "channels[0].state")
    /// }.unwrap();
    /// ```
    ///
    /// # Safety
    /// The caller must ensure the firmware is loaded and the variable exists.
    pub unsafe fn read_field<T: FromBytes>(
        &self,
        fw: &FirmwareInfo,
        var_name: &str,
        field_path: &str,
    ) -> Option<T> {
        let var_info = fw.variables.get(var_name)?;

        // Get the struct type name
        let type_name = match &var_info.type_info {
            TypeInfo::Struct { type_name, .. } => type_name.clone(),
            _ => {
                warn!(
                    "Variable '{}' is not a struct type: {:?}",
                    var_name, var_info.type_info
                );
                return None;
            }
        };

        // Resolve field offset and type via internal helpers
        let struct_info = fw.structs.get(&type_name)?;
        let offset = fw.resolve_field_offset(struct_info, field_path)?;
        let field_type = fw.resolve_field_type(struct_info, field_path)?;
        let size = field_type.byte_size();

        debug!(
            "Reading {}.{}: offset={}, size={}, type={:?}",
            var_name, field_path, offset, size, field_type
        );

        if size != std::mem::size_of::<T>() {
            warn!(
                "Size mismatch for {}.{}: field is {} bytes, requested {} bytes",
                var_name,
                field_path,
                size,
                std::mem::size_of::<T>()
            );
            return None;
        }

        let bytes = self.read_bytes(var_name, offset, size)?;
        Some(T::from_le_bytes(&bytes))
    }

    /// Read any numeric/bool field and return its value as f64.
    ///
    /// This method uses DWARF type info to determine the field's actual byte
    /// size and signedness, then reads the correct number of bytes and converts
    /// to f64. This avoids the caller needing to know the exact C type.
    ///
    /// # Safety
    /// The caller must ensure the firmware is loaded and the variable exists.
    pub unsafe fn read_field_as_f64(
        &self,
        fw: &FirmwareInfo,
        var_name: &str,
        field_path: &str,
    ) -> Option<f64> {
        let var_info = fw.variables.get(var_name)?;

        // If field_path is empty, read the variable itself as a leaf type
        if field_path.is_empty() {
            let size = var_info.type_info.byte_size();
            let bytes = self.read_bytes(var_name, 0, size)?;
            return Self::bytes_to_f64(&var_info.type_info, &bytes, var_name, field_path);
        }

        let type_name = match &var_info.type_info {
            TypeInfo::Struct { type_name, .. } => type_name.clone(),
            TypeInfo::Array { element_type, .. } => {
                // Handle array[index].field_path: parse leading [N] from field_path
                if let Some((index, rest)) = Self::parse_array_index(field_path) {
                    let elem_size = element_type.byte_size();
                    let base_offset = index * elem_size;
                    match element_type.as_ref() {
                        TypeInfo::Base { .. } | TypeInfo::Enum { .. } => {
                            // Leaf array element
                            let bytes = self.read_bytes(var_name, base_offset, elem_size)?;
                            return Self::bytes_to_f64(element_type, &bytes, var_name, field_path);
                        }
                        TypeInfo::Struct { type_name, .. } => {
                            if rest.is_empty() {
                                // Can't read struct as f64 directly
                                return None;
                            }
                            let struct_info = fw.structs.get(type_name)?;
                            let field_offset = fw.resolve_field_offset(struct_info, &rest)?;
                            let field_type = fw.resolve_field_type(struct_info, &rest)?;
                            let size = field_type.byte_size();
                            let bytes = self.read_bytes(var_name, base_offset + field_offset, size)?;
                            return Self::bytes_to_f64(&field_type, &bytes, var_name, field_path);
                        }
                        _ => return None,
                    }
                }
                return None;
            }
            _ => {
                warn!(
                    "Variable '{}' is not a struct type: {:?}",
                    var_name, var_info.type_info
                );
                return None;
            }
        };

        let struct_info = fw.structs.get(&type_name)?;
        let offset = fw.resolve_field_offset(struct_info, field_path)?;
        let field_type = fw.resolve_field_type(struct_info, field_path)?;
        let size = field_type.byte_size();

        let bytes = self.read_bytes(var_name, offset, size)?;

        Self::bytes_to_f64(&field_type, &bytes, var_name, field_path)
    }

    /// Parse a leading `[N]` from a field path, returning (index, rest).
    /// e.g. "[3].field" → Some((3, "field")), "[0]" → Some((0, ""))
    fn parse_array_index(path: &str) -> Option<(usize, String)> {
        if !path.starts_with('[') {
            return None;
        }
        let end = path.find(']')?;
        let index: usize = path[1..end].parse().ok()?;
        let rest = &path[end + 1..];
        let rest = rest.strip_prefix('.').unwrap_or(rest);
        Some((index, rest.to_string()))
    }

    /// Convert raw bytes to f64 based on the TypeInfo.
    fn bytes_to_f64(
        field_type: &TypeInfo,
        bytes: &[u8],
        var_name: &str,
        field_path: &str,
    ) -> Option<f64> {
        let size = field_type.byte_size();
        let value = match field_type {
            TypeInfo::Base { byte_size: 1, signed: true, .. } => {
                i8::from_le_bytes([bytes[0]]) as f64
            }
            TypeInfo::Base { byte_size: 1, signed: false, .. } => {
                // Could be bool or uint8_t — both read as u8
                bytes[0] as f64
            }
            TypeInfo::Base { byte_size: 2, signed: true, .. } => {
                i16::from_le_bytes([bytes[0], bytes[1]]) as f64
            }
            TypeInfo::Base { byte_size: 2, signed: false, .. } => {
                u16::from_le_bytes([bytes[0], bytes[1]]) as f64
            }
            TypeInfo::Base { byte_size: 4, signed: true, .. } => {
                i32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]) as f64
            }
            TypeInfo::Base { byte_size: 4, signed: false, .. } => {
                u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]) as f64
            }
            TypeInfo::Base { byte_size: 8, signed: true, .. } => {
                let mut buf = [0u8; 8];
                buf.copy_from_slice(&bytes[..8]);
                i64::from_le_bytes(buf) as f64
            }
            TypeInfo::Base { byte_size: 8, signed: false, .. } => {
                let mut buf = [0u8; 8];
                buf.copy_from_slice(&bytes[..8]);
                u64::from_le_bytes(buf) as f64
            }
            TypeInfo::Enum { byte_size: 4, .. } => {
                i32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]) as f64
            }
            TypeInfo::Enum { byte_size: 2, .. } => {
                i16::from_le_bytes([bytes[0], bytes[1]]) as f64
            }
            TypeInfo::Enum { byte_size: 1, .. } => {
                bytes[0] as f64
            }
            // IEEE-754 floats must be decoded as floats — reading their bytes
            // as an integer yields garbage (this was a latent bug).
            TypeInfo::Float { byte_size: 4, .. } => {
                f32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]) as f64
            }
            TypeInfo::Float { byte_size: 8, .. } => {
                let mut buf = [0u8; 8];
                buf.copy_from_slice(&bytes[..8]);
                f64::from_le_bytes(buf)
            }
            // Bitfield: read the underlying storage unit, then shift/mask out the
            // member's bits. `bit_offset` is relative to the member's byte offset
            // (normalized when the field was parsed). Sign-extend when signed.
            TypeInfo::Bitfield { bit_offset, bit_size, storage_size, signed } => {
                if *bit_size == 0 || *bit_size > 64 {
                    return None;
                }
                let n = (*storage_size).min(8).min(bytes.len());
                let mut buf = [0u8; 8];
                buf[..n].copy_from_slice(&bytes[..n]);
                let raw = u64::from_le_bytes(buf);
                let mask = if *bit_size == 64 { u64::MAX } else { (1u64 << bit_size) - 1 };
                let field = (raw >> (bit_offset % 64)) & mask;
                if *signed && (field >> (bit_size - 1)) & 1 == 1 {
                    // Sign-extend: set all bits above the field.
                    ((field | !mask) as i64) as f64
                } else {
                    field as f64
                }
            }
            _ => {
                warn!(
                    "Unsupported type for read_field_as_f64: {}.{} ({:?}, {} bytes)",
                    var_name, field_path, field_type, size
                );
                return None;
            }
        };

        Some(value)
    }

}

// ============================================================
// FromBytes trait — type-safe byte interpretation
// ============================================================

/// Trait for types that can be constructed from little-endian bytes.
pub trait FromBytes: Sized {
    fn from_le_bytes(bytes: &[u8]) -> Self;
}

impl FromBytes for i8 {
    fn from_le_bytes(bytes: &[u8]) -> Self {
        Self::from_le_bytes([bytes[0]])
    }
}

impl FromBytes for u8 {
    fn from_le_bytes(bytes: &[u8]) -> Self {
        Self::from_le_bytes([bytes[0]])
    }
}

impl FromBytes for i16 {
    fn from_le_bytes(bytes: &[u8]) -> Self {
        Self::from_le_bytes([bytes[0], bytes[1]])
    }
}

impl FromBytes for u16 {
    fn from_le_bytes(bytes: &[u8]) -> Self {
        Self::from_le_bytes([bytes[0], bytes[1]])
    }
}

impl FromBytes for i32 {
    fn from_le_bytes(bytes: &[u8]) -> Self {
        Self::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]])
    }
}

impl FromBytes for u32 {
    fn from_le_bytes(bytes: &[u8]) -> Self {
        Self::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]])
    }
}

impl FromBytes for i64 {
    fn from_le_bytes(bytes: &[u8]) -> Self {
        let mut buf = [0u8; 8];
        buf.copy_from_slice(&bytes[..8]);
        Self::from_le_bytes(buf)
    }
}

impl FromBytes for u64 {
    fn from_le_bytes(bytes: &[u8]) -> Self {
        let mut buf = [0u8; 8];
        buf.copy_from_slice(&bytes[..8]);
        Self::from_le_bytes(buf)
    }
}

impl FromBytes for bool {
    fn from_le_bytes(bytes: &[u8]) -> Self {
        bytes[0] != 0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_f32_as_float_not_int() {
        // 1.5f32 little-endian. Decoding these bytes as an integer would give
        // 1069547520, not 1.5 — this guards the float-decode bug fix.
        let bytes = 1.5f32.to_le_bytes();
        let ti = TypeInfo::Float { name: "float".into(), byte_size: 4 };
        let v = SymbolResolver::bytes_to_f64(&ti, &bytes, "v", "f").unwrap();
        assert_eq!(v, 1.5);
    }

    #[test]
    fn decodes_f64() {
        let bytes = (-2.25f64).to_le_bytes();
        let ti = TypeInfo::Float { name: "double".into(), byte_size: 8 };
        let v = SymbolResolver::bytes_to_f64(&ti, &bytes, "v", "f").unwrap();
        assert_eq!(v, -2.25);
    }

    #[test]
    fn decodes_unsigned_bitfield() {
        // Extract bits [4..7) (value 0b101 = 5) from a 1-byte storage unit.
        let storage = [0b0101_0000u8];
        let ti = TypeInfo::Bitfield { bit_offset: 4, bit_size: 3, storage_size: 1, signed: false };
        let v = SymbolResolver::bytes_to_f64(&ti, &storage, "v", "f").unwrap();
        assert_eq!(v, 5.0);
    }

    #[test]
    fn decodes_signed_bitfield_sign_extends() {
        // 3-bit signed field holding 0b111 = -1.
        let storage = [0b0000_0111u8];
        let ti = TypeInfo::Bitfield { bit_offset: 0, bit_size: 3, storage_size: 1, signed: true };
        let v = SymbolResolver::bytes_to_f64(&ti, &storage, "v", "f").unwrap();
        assert_eq!(v, -1.0);
    }
}
