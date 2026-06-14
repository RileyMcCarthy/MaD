#[path = "thermostat.rs"]
mod thermostat;
use thermostat::*;
fn hex(b: &[u8]) -> String { b.iter().map(|x| format!("{:02x}", x)).collect() }
fn main() {
    let r = Reading { temp: 23, humidity: 44 };
    println!("{}", hex(&r.encode()));
    let d = Datum { channel: 7, value: Sample::Temperature(20) };
    println!("{}", hex(&d.encode()));
    let d2 = Datum { channel: 3, value: Sample::Humidity(55) };
    println!("{}", hex(&d2.encode()));
}
