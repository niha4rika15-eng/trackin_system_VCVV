(function (root, factory) {
  "use strict";
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.PCNSQR = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  function validateAnchor(value) {
    if (!value || typeof value !== "object") return null;
    const lat = Number(value.lat);
    const lng = Number(value.lng);
    const floor = value.floor == null || value.floor === "" ? 0 : Number(value.floor);
    const label = String(value.label || value.name || value.location || "").trim();
    if (!Number.isFinite(lat) || Math.abs(lat) > 90 ||
        !Number.isFinite(lng) || Math.abs(lng) > 180 ||
        !Number.isInteger(floor) || !label) return null;
    return { lat, lng, floor, label };
  }

  function parsePayload(value) {
    const text = String(value || "").trim();
    if (!text) return null;

    try {
      const url = new URL(text);
      if (url.searchParams.get("pcns_qr") === "1") {
        return validateAnchor({
          lat: url.searchParams.get("lat"),
          lng: url.searchParams.get("lng"),
          floor: url.searchParams.get("floor"),
          label: url.searchParams.get("name"),
        });
      }
      const reference = url.searchParams.get("anchor");
      if (reference) return { reference };
    } catch (_) {
      // A JSON payload is also supported for printed or third-party QR codes.
    }

    try {
      const payload = JSON.parse(text);
      if (payload && typeof payload === "object" && !Array.isArray(payload)) {
        if (payload.type && payload.type !== "pcns-anchor") return null;
        return validateAnchor(payload);
      }
    } catch (_) {
      return null;
    }
    return null;
  }

  function buildUrl(anchor, baseUrl) {
    const valid = validateAnchor(anchor);
    if (!valid) throw new TypeError("A QR anchor needs a label, valid coordinates, and a whole-number floor.");
    const url = new URL(baseUrl);
    url.search = "";
    url.hash = "";
    url.searchParams.set("pcns_qr", "1");
    url.searchParams.set("name", valid.label);
    url.searchParams.set("lat", String(valid.lat));
    url.searchParams.set("lng", String(valid.lng));
    url.searchParams.set("floor", String(valid.floor));
    return url.toString();
  }

  return { validateAnchor, parsePayload, buildUrl };
});
