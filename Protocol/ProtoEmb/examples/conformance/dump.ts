import { encodeReading, encodeDatum } from './thermostat';
const hex = (b: Uint8Array) => Array.from(b).map((x) => x.toString(16).padStart(2, '0')).join('');
console.log(hex(encodeReading({ temp: 23, humidity: 44 })));
console.log(hex(encodeDatum({ channel: 7, value: { tag: 'temperature', value: 20 } })));
console.log(hex(encodeDatum({ channel: 3, value: { tag: 'humidity', value: 55 } })));
