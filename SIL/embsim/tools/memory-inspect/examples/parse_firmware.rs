//! Quick smoke test: parse libfirmware.a and print what we found.
//!
//! Usage:
//!   cargo run --example parse_firmware -- <path-to-libfirmware.a>

use embsim_memory_inspect::FirmwareInfo;
use std::path::Path;

fn main() {
    // Simple tracing init
    tracing_subscriber::fmt()
        .with_env_filter("info")
        .init();

    let args: Vec<String> = std::env::args().collect();
    let path = args
        .get(1)
        .expect("Usage: parse_firmware <path-to-libfirmware.a>");

    let fw = FirmwareInfo::from_archive(Path::new(path)).expect("Failed to parse archive");

    println!("\n=== ENUMS ({}) ===", fw.enums.len());
    let mut enum_names: Vec<_> = fw.enums.keys().collect();
    enum_names.sort();
    for name in &enum_names {
        let e = &fw.enums[*name];
        println!("  {} ({} bytes, {} variants)", name, e.byte_size, e.variants.len());
        for (vname, vval) in &e.variants {
            println!("    {} = {}", vname, vval);
        }
    }

    println!("\n=== STRUCTS ({}) ===", fw.structs.len());
    let mut struct_names: Vec<_> = fw.structs.keys().collect();
    struct_names.sort();
    for name in &struct_names {
        let s = &fw.structs[*name];
        println!("  {} ({} bytes, {} fields)", name, s.byte_size, s.fields.len());
        for f in &s.fields {
            println!("    +{:4} {} ({:?})", f.offset, f.name, f.type_info);
        }
    }

    println!("\n=== VARIABLES ({}) ===", fw.variables.len());
    let mut var_names: Vec<_> = fw.variables.keys().collect();
    var_names.sort();
    for name in &var_names {
        let v = &fw.variables[*name];
        println!("  {} ({:?}) [{}]", name, v.type_info, v.source_file.as_deref().unwrap_or("?"));
    }

    // Demonstrate the lookup API against whatever this firmware actually
    // contains (no project-specific symbol names hardcoded) using the fallible
    // `try_*` accessors so a different firmware doesn't panic.
    println!("\n=== LOOKUP API DEMO ===");

    if let Some(enum_name) = enum_names.first() {
        if let Some((variant, _)) = fw.enums[*enum_name].variants.first() {
            println!(
                "  enum value of '{}' = {:?}",
                variant,
                fw.try_enum_value(variant)
            );
        }
        println!(
            "  channel_count('{}') (suffix '{}') = {:?}",
            enum_name,
            fw.count_suffix,
            fw.try_channel_count(enum_name)
        );
    } else {
        println!("  (no enums in this archive)");
    }

    if let Some(struct_name) = struct_names.first() {
        if let Some(field) = fw.structs[*struct_name].fields.first() {
            println!(
                "  field offset of '{}.{}' = {:?}",
                struct_name,
                field.name,
                fw.try_field_offset(struct_name, &field.name)
            );
        }
    } else {
        println!("  (no structs in this archive)");
    }
}
