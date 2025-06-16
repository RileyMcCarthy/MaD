/* eslint-disable no-plusplus */
/* eslint-disable no-bitwise */
import { EventEmitter } from 'events';
import { Notification } from '@shared/SharedInterface';
import SerialPortHandler from './SerialPortHandler';
import { Message } from 'rsuite';

export enum ReadType {
  SAMPLE,
  STATE,
  MACHINE_CONFIGURATION,
  FIRMWARE_VERSION,
}

export enum WriteType {
  MACHINE_CONFIGURATION,
  MOTION_ENABLE,
  TEST_RUN,
  MANUAL_MOVE,
  TEST_MOVE,
  SAMPLE_PROFILE,
  GAUGE_LENGTH,
  GAUGE_FORCE,
  READ_FIRMWARE_VERSION,
}

enum MessageType {
  READ,
  WRITE,
}

enum ResponseType {
  NACK,
  ACK,
  DATA,
  NOTIFICATION,
}

enum MessageIndex {
  SYNC = 0,
  TYPE = 1,
  COMMAND = 2,
  LENGTH_LOWER = 3,
  LENGTH_UPPER = 4,
  CRC,
  HEADER_SIZE,
}

function crc8(data: Buffer) {
  let crc = 0;
  for (let i = 0; i < data.length; i++) {
    let inbyte = data[i];
    for (let j = 0; j < 8; j++) {
      const mix = (crc ^ inbyte) & 0x01;
      crc >>= 1;
      if (mix) {
        crc ^= 0x8c;
      }
      inbyte >>= 1;
    }
  }
  return crc;
}

class DataProcessor extends EventEmitter {
  static readonly SYNC_BYTE = 0x55;

  private buf: Buffer = Buffer.alloc(0);

  constructor(private serialport: SerialPortHandler) {
    super();
    serialport.on('data', (data: Buffer) => {
      // Process each byte in the buffer
      for (let i = 0; i < data.length; i++) {
        this.processByte(data[i]);
      }
    });
  }

  writeData(command: WriteType, data: Buffer) {
    const { length } = data;
    const lengthLower = length & 0xff;
    const lengthUpper = (length >> 8) & 0xff;
    const message = Buffer.concat([
      Buffer.from([DataProcessor.SYNC_BYTE]),
      Buffer.from([MessageType.WRITE]),
      Buffer.from([command]),
      Buffer.from([lengthLower]),
      Buffer.from([lengthUpper]),
      data,
      Buffer.from([crc8(data)]),
    ]);
    this.serialport.write_data(message);
  }

  readData(command: ReadType) {
    const message = Buffer.concat([
      Buffer.from([DataProcessor.SYNC_BYTE]),
      Buffer.from([MessageType.READ]),
      Buffer.from([command]),
    ]);
    this.serialport.write_data(message);
  }

  private processByte(byte: number) {
    switch (this.buf.length as MessageIndex) {
      case MessageIndex.SYNC:
        if (byte === DataProcessor.SYNC_BYTE) {
          this.buf = Buffer.from([byte]);
        }
        break;
      case MessageIndex.TYPE:
        if (byte in ResponseType) {
          this.buf = Buffer.concat([this.buf, Buffer.from([byte])]);
        } else this.buf = Buffer.alloc(0);
        break;
      case MessageIndex.COMMAND:
        if (
          this.handleMessageType(
            this.buf[MessageIndex.TYPE] as ResponseType,
            byte as WriteType,
          )
        )
          this.buf = Buffer.concat([this.buf, Buffer.from([byte])]);
        else this.buf = Buffer.alloc(0);
        break;
      case MessageIndex.LENGTH_LOWER:
        this.buf = Buffer.concat([this.buf, Buffer.from([byte])]);
        break;
      case MessageIndex.LENGTH_UPPER:
        this.buf = Buffer.concat([this.buf, Buffer.from([byte])]);
        break;
      default: {
        // Handle data + CRC
        const command = this.buf[MessageIndex.COMMAND] as ReadType;
        const type = this.buf[MessageIndex.TYPE] as ResponseType;
        const length =
          this.buf[MessageIndex.LENGTH_LOWER] +
          // eslint-disable-next-line no-bitwise
          (this.buf[MessageIndex.LENGTH_UPPER] << 8);

        this.buf = Buffer.concat([this.buf, Buffer.from([byte])]);
        const expectedLength = length + MessageIndex.HEADER_SIZE; // Command + Length + Data + CRC
        if (this.buf.length === expectedLength) {
          this.processMessage(
            type,
            command,
            this.buf.slice(MessageIndex.HEADER_SIZE - 1, -1),
            byte,
          );
          this.buf = Buffer.alloc(0);
        }
      }
    }
  }

  private handleMessageType(type: ResponseType, messageCommand: WriteType) {
    let append;
    // NACK/ACK do not have length/data/crc and can be emitted now to save bandwidth
    switch (type) {
      case ResponseType.NACK:
        console.log('NACK:', messageCommand);
        this.emit('ack', messageCommand, false);
        append = false;
        break;
      case ResponseType.ACK:
        this.emit('ack', messageCommand, true);
        append = false;
        break;
      case ResponseType.DATA:
        append = true;
        break;
      case ResponseType.NOTIFICATION:
        append = true;
        break;
      default:
        append = false;
        console.log('Unknown type:', type);
    }
    return append;
  }

  private processMessage(
    messageType: ResponseType,
    messageCommand: ReadType,
    messageData: Buffer,
    crc: number,
  ) {
    if (crc8(messageData) === crc) {
      switch (messageType) {
        case ResponseType.DATA:
          //console.log('Data:', messageCommand, messageData.toString());
          this.emit('data', messageCommand, messageData.toString());
          break;
        case ResponseType.NOTIFICATION:
          try {
            this.emit(
              'notification',
              JSON.parse(
                messageData.toString().replace(/(\r\n|\n|\r)/gm, ''),
              ) as Notification,
            );
          } catch (error) {
            console.log('Notification:', messageData.toString());
            console.error('Failed to parse notification:', error);
          }
          break;
        case ResponseType.NACK:
        case ResponseType.ACK:
        default:
          console.log('Unknown type:', messageType);
      }
    }
  }
}

export default DataProcessor;
