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

    // Test some specific lookups (all panic if not found)
    println!("\n=== SPECIFIC LOOKUPS ===");

    println!("  HAL_GPIO_SERVO_ENA = {}", fw.enum_channel("HAL_GPIO_SERVO_ENA"));
    println!("  HAL_GPIO_channel_E count = {}", fw.channel_count("HAL_GPIO_channel_E"));

    // Test field_offset
    println!("  dev_cogManager_data_S.channels[0].state offset = {}",
        fw.field_offset("dev_cogManager_data_S", "channels[0].state"));
    println!("  dev_cogManager_data_S.channels[3].state offset = {}",
        fw.field_offset("dev_cogManager_data_S", "channels[3].state"));
    println!("  app_control_data_S.state offset = {}",
        fw.field_offset("app_control_data_S", "state"));
    println!("  dev_stepper_data_S.channels[0].currentSteps offset = {}",
        fw.field_offset("dev_stepper_data_S", "channels[0].currentSteps"));
    println!("  dev_stepper_data_S.lock offset = {}",
        fw.field_offset("dev_stepper_data_S", "lock"));
}
