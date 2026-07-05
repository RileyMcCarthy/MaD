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

    // A symbol defined in the test binary so SymbolResolver can locate and read
    // it. `#[no_mangle]` keeps the name stable; on macOS the resolver strips the
    // leading underscore the linker adds.
    #[no_mangle]
    pub static EMBSIM_TEST_SYM: [u8; 4] = [1, 2, 3, 4];

    // ── bytes_to_f64: Base, every size and sign ──

    /// Signed bases of every width decode to their signed value (including
    /// negatives) as f64.
    #[test]
    fn bytes_to_f64_signed_bases() {
        let cases: &[(usize, i64)] = &[(1, -5), (2, -300), (4, -70_000), (8, -5_000_000_000)];
        for &(size, val) in cases {
            let bytes = match size {
                1 => (val as i8).to_le_bytes().to_vec(),
                2 => (val as i16).to_le_bytes().to_vec(),
                4 => (val as i32).to_le_bytes().to_vec(),
                8 => (val as i64).to_le_bytes().to_vec(),
                _ => unreachable!(),
            };
            let ti = TypeInfo::Base { name: "i".into(), byte_size: size, signed: true };
            let got = SymbolResolver::bytes_to_f64(&ti, &bytes, "v", "f").unwrap();
            assert_eq!(got, val as f64, "signed base size {size}");
        }
    }

    /// Unsigned bases of every width decode to their unsigned value as f64.
    #[test]
    fn bytes_to_f64_unsigned_bases() {
        let cases: &[(usize, u64)] = &[(1, 200), (2, 60_000), (4, 4_000_000_000), (8, 10_000_000_000)];
        for &(size, val) in cases {
            let bytes = match size {
                1 => (val as u8).to_le_bytes().to_vec(),
                2 => (val as u16).to_le_bytes().to_vec(),
                4 => (val as u32).to_le_bytes().to_vec(),
                8 => (val as u64).to_le_bytes().to_vec(),
                _ => unreachable!(),
            };
            let ti = TypeInfo::Base { name: "u".into(), byte_size: size, signed: false };
            let got = SymbolResolver::bytes_to_f64(&ti, &bytes, "v", "f").unwrap();
            assert_eq!(got, val as f64, "unsigned base size {size}");
        }
    }

    /// A 1-byte unsigned base decodes a bool's storage (0 or 1) directly.
    #[test]
    fn bytes_to_f64_bool_like_u8() {
        let ti = TypeInfo::Base { name: "bool".into(), byte_size: 1, signed: false };
        assert_eq!(SymbolResolver::bytes_to_f64(&ti, &[1], "v", "f").unwrap(), 1.0);
        assert_eq!(SymbolResolver::bytes_to_f64(&ti, &[0], "v", "f").unwrap(), 0.0);
    }

    // ── bytes_to_f64: Enum sizes ──

    /// Enums of width 1/2/4 decode through their integer storage.
    #[test]
    fn bytes_to_f64_enum_sizes() {
        let e1 = TypeInfo::Enum { type_name: "E".into(), byte_size: 1 };
        assert_eq!(SymbolResolver::bytes_to_f64(&e1, &[7], "v", "f").unwrap(), 7.0);

        let e2 = TypeInfo::Enum { type_name: "E".into(), byte_size: 2 };
        assert_eq!(SymbolResolver::bytes_to_f64(&e2, &300i16.to_le_bytes(), "v", "f").unwrap(), 300.0);

        let e4 = TypeInfo::Enum { type_name: "E".into(), byte_size: 4 };
        assert_eq!(SymbolResolver::bytes_to_f64(&e4, &123_456i32.to_le_bytes(), "v", "f").unwrap(), 123_456.0);
    }

    // ── bytes_to_f64: unsupported / degenerate ──

    /// Unsupported types (Struct/Union/Pointer/Array/Unknown, and odd Base/Enum
    /// sizes) return `None` instead of decoding garbage.
    #[test]
    fn bytes_to_f64_unsupported_returns_none() {
        let buf = [0u8; 8];
        let unsupported = [
            TypeInfo::Struct { type_name: "S".into(), byte_size: 8 },
            TypeInfo::Union { type_name: "U".into(), byte_size: 8 },
            TypeInfo::Pointer { byte_size: 8 },
            TypeInfo::Unknown { byte_size: 8 },
            // A Base width the match arms don't cover (3 bytes).
            TypeInfo::Base { name: "odd".into(), byte_size: 3, signed: false },
            // An Enum width the match arms don't cover (8 bytes).
            TypeInfo::Enum { type_name: "E".into(), byte_size: 8 },
        ];
        for ti in &unsupported {
            assert!(
                SymbolResolver::bytes_to_f64(ti, &buf, "v", "f").is_none(),
                "expected None for {ti:?}"
            );
        }
    }

    // ── bytes_to_f64: bitfield edge cases ──

    /// A bitfield with `bit_size == 0` or `> 64` returns `None`.
    #[test]
    fn bytes_to_f64_bitfield_invalid_width() {
        let buf = [0xFFu8; 8];
        let zero = TypeInfo::Bitfield { bit_offset: 0, bit_size: 0, storage_size: 1, signed: false };
        assert!(SymbolResolver::bytes_to_f64(&zero, &buf, "v", "f").is_none());

        let too_wide = TypeInfo::Bitfield { bit_offset: 0, bit_size: 65, storage_size: 8, signed: false };
        assert!(SymbolResolver::bytes_to_f64(&too_wide, &buf, "v", "f").is_none());
    }

    /// A full-width (64-bit) bitfield uses the all-ones mask without overflow.
    #[test]
    fn bytes_to_f64_bitfield_full_width() {
        let buf = 0x00FF_00FF_00FF_00FFu64.to_le_bytes();
        let ti = TypeInfo::Bitfield { bit_offset: 0, bit_size: 64, storage_size: 8, signed: false };
        let got = SymbolResolver::bytes_to_f64(&ti, &buf, "v", "f").unwrap();
        assert_eq!(got, 0x00FF_00FF_00FF_00FFu64 as f64);
    }

    /// A multi-byte unsigned bitfield extracts the right run of bits.
    #[test]
    fn bytes_to_f64_bitfield_multibyte() {
        // 16-bit storage, extract bits [8..12) of 0xF300 → 0x3 = 3.
        let buf = 0xF300u16.to_le_bytes();
        let ti = TypeInfo::Bitfield { bit_offset: 8, bit_size: 4, storage_size: 2, signed: false };
        let got = SymbolResolver::bytes_to_f64(&ti, &buf, "v", "f").unwrap();
        assert_eq!(got, 3.0);
    }

    // ── parse_array_index ──

    /// `parse_array_index` parses a leading `[N]` and the remaining path.
    #[test]
    fn parse_array_index_cases() {
        assert_eq!(SymbolResolver::parse_array_index("[3].field"), Some((3, "field".to_string())));
        assert_eq!(SymbolResolver::parse_array_index("[0]"), Some((0, String::new())));
        assert_eq!(SymbolResolver::parse_array_index("[12].a.b"), Some((12, "a.b".to_string())));
        // No leading bracket → None.
        assert_eq!(SymbolResolver::parse_array_index("no_bracket"), None);
        // Non-numeric index → None.
        assert_eq!(SymbolResolver::parse_array_index("[abc].f"), None);
        // Unterminated bracket → None.
        assert_eq!(SymbolResolver::parse_array_index("[3"), None);
    }

    // ── FromBytes round-trips ──

    /// Every `FromBytes` impl round-trips its little-endian encoding.
    #[test]
    fn from_bytes_round_trips() {
        assert_eq!(<i8 as FromBytes>::from_le_bytes(&(-12i8).to_le_bytes()), -12);
        assert_eq!(<u8 as FromBytes>::from_le_bytes(&250u8.to_le_bytes()), 250);
        assert_eq!(<i16 as FromBytes>::from_le_bytes(&(-1234i16).to_le_bytes()), -1234);
        assert_eq!(<u16 as FromBytes>::from_le_bytes(&60000u16.to_le_bytes()), 60000);
        assert_eq!(<i32 as FromBytes>::from_le_bytes(&(-100000i32).to_le_bytes()), -100000);
        assert_eq!(<u32 as FromBytes>::from_le_bytes(&4_000_000_000u32.to_le_bytes()), 4_000_000_000);
        assert_eq!(<i64 as FromBytes>::from_le_bytes(&(-5_000_000_000i64).to_le_bytes()), -5_000_000_000);
        assert_eq!(<u64 as FromBytes>::from_le_bytes(&10_000_000_000u64.to_le_bytes()), 10_000_000_000);
        // bool: any nonzero byte → true, zero → false.
        assert!(<bool as FromBytes>::from_le_bytes(&[1]));
        assert!(<bool as FromBytes>::from_le_bytes(&[0xFF]));
        assert!(!<bool as FromBytes>::from_le_bytes(&[0]));
    }

    // ── SymbolResolver ──

    /// `from_binary` on a clearly-invalid path yields `Err`.
    #[test]
    fn from_binary_invalid_path_errs() {
        let res = SymbolResolver::from_binary(Path::new("/no/such/binary/embsim_xyz"));
        assert!(res.is_err(), "missing binary must error");
    }

    /// `from_binary` on a path that exists but is not an object file yields
    /// `Err` (the parse branch).
    #[test]
    fn from_binary_non_object_errs() {
        let dir = std::env::temp_dir().join(format!("embsim_notobj_{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let junk = dir.join("junk.bin");
        std::fs::write(&junk, b"not an object file at all").unwrap();
        let res = SymbolResolver::from_binary(&junk);
        assert!(res.is_err(), "junk file must fail to parse as an object");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// `SymbolResolver::new()` parses the running test binary and reports a
    /// nonexistent symbol as `None`.
    #[test]
    fn new_resolves_self_and_misses_unknown_symbol() {
        let resolver = SymbolResolver::new().expect("resolver should parse the test binary");
        assert!(
            resolver.symbol_address("definitely_not_a_symbol_xyz").is_none(),
            "an unknown symbol must resolve to None"
        );
    }

    /// The resolver finds a symbol defined in this test binary and `read_bytes`
    /// round-trips its contents. The resolver strips the macOS leading
    /// underscore, so we look it up by its source name.
    #[test]
    fn resolves_and_reads_own_symbol() {
        // Touch the static so the linker can't strip it.
        assert_eq!(EMBSIM_TEST_SYM, [1, 2, 3, 4]);

        let resolver = SymbolResolver::new().expect("resolver should parse the test binary");

        // Some platforms/strip configurations may omit local statics from the
        // symbol table; only assert the read path when the symbol is present.
        if resolver.symbol_address("EMBSIM_TEST_SYM").is_some() {
            let bytes = unsafe { resolver.read_bytes("EMBSIM_TEST_SYM", 0, 4) }
                .expect("read_bytes should succeed for a resolvable symbol");
            assert_eq!(bytes, vec![1, 2, 3, 4], "read_bytes must round-trip the static's contents");

            // Offset + partial length reads a sub-slice.
            let tail = unsafe { resolver.read_bytes("EMBSIM_TEST_SYM", 2, 2) }.unwrap();
            assert_eq!(tail, vec![3, 4]);
        } else {
            eprintln!("SKIP: EMBSIM_TEST_SYM not present in symbol table on this platform");
        }
    }

    /// `read_bytes` for an unknown symbol returns `None` (no panic).
    #[test]
    fn read_bytes_unknown_symbol_is_none() {
        let resolver = SymbolResolver::new().expect("resolver");
        let got = unsafe { resolver.read_bytes("definitely_not_a_symbol_xyz", 0, 4) };
        assert!(got.is_none(), "reading an unknown symbol must be None");
    }
}
