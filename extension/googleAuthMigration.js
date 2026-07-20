// Decoder for Google Authenticator's "Transfer accounts" export QR
// (otpauth-migration://offline?data=<base64 protobuf>). Hand-rolled protobuf
// reader — the schema only ever uses wire types 0 (varint) and 2
// (length-delimited), so a generic protobuf library would be overkill.
//
// message MigrationPayload {
//   message OtpParameters {
//     bytes secret = 1; string name = 2; string issuer = 3;
//     int32 algorithm = 4; int32 digits = 5; int32 type = 6; int64 counter = 7;
//     // type: 1 = HOTP, 2 = TOTP
//   }
//   repeated OtpParameters otp_parameters = 1;
//   int32 version = 2; int32 batch_size = 3; int32 batch_index = 4; int64 batch_id = 5;
// }

function readVarint(bytes, pos) {
  let result = 0n, shift = 0n;
  while (true) {
    const b = bytes[pos++];
    result |= BigInt(b & 0x7f) << shift;
    if ((b & 0x80) === 0) break;
    shift += 7n;
  }
  return [result, pos];
}

function readProtoField(bytes, pos) {
  const [tag, p1] = readVarint(bytes, pos);
  const fieldNumber = Number(tag >> 3n);
  const wireType = Number(tag & 7n);
  if (wireType === 0) {
    const [value, p2] = readVarint(bytes, p1);
    return { fieldNumber, value, pos: p2 };
  }
  if (wireType === 2) {
    const [len, p2] = readVarint(bytes, p1);
    const length = Number(len);
    const value = bytes.slice(p2, p2 + length);
    return { fieldNumber, value, pos: p2 + length };
  }
  throw new Error('Unsupported protobuf wire type: ' + wireType);
}

function parseOtpParameters(bytes) {
  const otp = { secret: new Uint8Array(0), name: '', issuer: '', algorithm: 0, digits: 0, type: 0 };
  const decoder = new TextDecoder();
  let pos = 0;
  while (pos < bytes.length) {
    const f = readProtoField(bytes, pos);
    pos = f.pos;
    switch (f.fieldNumber) {
      case 1: otp.secret = f.value; break;
      case 2: otp.name = decoder.decode(f.value); break;
      case 3: otp.issuer = decoder.decode(f.value); break;
      case 4: otp.algorithm = Number(f.value); break;
      case 5: otp.digits = Number(f.value); break;
      case 6: otp.type = Number(f.value); break;
    }
  }
  return otp;
}

function parseMigrationPayload(bytes) {
  const payload = { otpParameters: [], version: 0, batchSize: 1, batchIndex: 0, batchId: '0' };
  let pos = 0;
  while (pos < bytes.length) {
    const f = readProtoField(bytes, pos);
    pos = f.pos;
    switch (f.fieldNumber) {
      case 1: payload.otpParameters.push(parseOtpParameters(f.value)); break;
      case 2: payload.version = Number(f.value); break;
      case 3: payload.batchSize = Number(f.value); break;
      case 4: payload.batchIndex = Number(f.value); break;
      case 5: payload.batchId = f.value.toString(); break;
    }
  }
  return payload;
}

// uri: an otpauth-migration://offline?data=... string decoded from a QR image.
// Returns null if it isn't a recognizable migration payload.
function parseMigrationUri(uri) {
  try {
    const url = new URL(uri);
    if (url.protocol !== 'otpauth-migration:') return null;
    // GA's raw QR text isn't always percent-encoded, and URLSearchParams
    // treats a literal '+' as a space (form-encoding convention) — undo that
    // before base64-decoding, since '+' is a valid base64 character.
    const data = new URLSearchParams(url.search).get('data');
    if (!data) return null;
    const binary = atob(data.replace(/ /g, '+'));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return parseMigrationPayload(bytes);
  } catch {
    return null;
  }
}
