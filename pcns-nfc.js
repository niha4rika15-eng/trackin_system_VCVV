/* Pure NDEF decoding helpers for PCNS. Browser + Node-testable; does not access NFC hardware. */
(function (root, factory) {
  "use strict";
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.PCNSNFC = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const URI_PREFIXES = [
    "", "http://www.", "https://www.", "http://", "https://", "tel:", "mailto:",
    "ftp://anonymous:anonymous@", "ftp://ftp.", "ftps://", "sftp://", "smb://", "nfs://",
    "ftp://", "dav://", "news:", "telnet://", "imap:", "rtsp://", "urn:", "pop:",
    "sip:", "sips:", "tftp:", "btspp://", "btl2cap://", "btgoep://", "tcpobex://",
    "irdaobex://", "file://", "urn:epc:id:", "urn:epc:tag:", "urn:epc:pat:",
    "urn:epc:raw:", "urn:epc:", "urn:nfc:"
  ];

  function toBytes(data) {
    if (typeof data === "string") return data;
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    return new Uint8Array();
  }

  function decodeText(data) {
    if (typeof data === "string") return data.trim();
    const bytes = toBytes(data);
    if (!bytes.length) return "";
    const statusByte = bytes[0];
    const languageLength = statusByte & 0x3f;
    // NFC Forum Text RTD's language code is normally 2–8 ASCII bytes. Bound the
    // check so a plain JSON body beginning with '{' cannot be mistaken for metadata.
    if (languageLength >= 2 && languageLength <= 8 && 1 + languageLength < bytes.length) {
      const body = bytes.slice(1 + languageLength);
      const charset = (statusByte & 0x80) !== 0 ? "utf-16be" : "utf-8";
      const decoded = new TextDecoder(charset).decode(body).trim();
      if (decoded) return decoded;
    }
    return new TextDecoder().decode(bytes).replace(/^[\u0000-\u001f]{1,3}/, "").trim();
  }

  function decodeUri(data) {
    if (typeof data === "string") return data.trim();
    const bytes = toBytes(data);
    if (!bytes.length) return "";
    const decoded = new TextDecoder().decode(bytes).trim();
    if (/^(https?:|mailto:|tel:|urn:)/i.test(decoded)) return decoded;
    const prefix = URI_PREFIXES[bytes[0]];
    if (prefix != null) return prefix + new TextDecoder().decode(bytes.slice(1)).trim();
    return decoded.replace(/^[\u0000-\u001f]+/, "");
  }

  return { decodeText, decodeUri };
});
