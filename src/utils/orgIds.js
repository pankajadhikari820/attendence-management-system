const ALPHANUM = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';

function randomChars(length) {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  let out = '';
  for (let i = 0; i < length; i++) {
    out += ALPHANUM[bytes[i] % ALPHANUM.length];
  }
  return out;
}

export function generateOrgId() {
  return `ORG-${randomChars(5)}`;
}

export function generateMemberPublicId(orgId) {
  const cleanOrg = String(orgId || 'ORG00000')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
  return `SA-${cleanOrg}-${randomChars(6)}`;
}

export function generateOpaqueQrToken() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Encodes a member's opaque revocable QR token with zero sensitive personal details.
 */
export function encodeMemberQrPayload(orgId, tokenId) {
  return JSON.stringify({
    v: 2,
    app: 'SmartAttend',
    type: 'member_id',
    orgId: String(orgId || '').trim(),
    token: String(tokenId || '').trim(),
  });
}

/**
 * Parses either:
 *  - v2 member QR JSON: { v: 2, type: 'member_id', orgId, token }
 *  - v1 session QR JSON: { v: 1, sessionId, token, exp }
 *  - Compact member public ID: SA-ORGXXXXX-YYYYYY
 *  - Compact session format: sessionId:token
 */
export function parseUniversalQrPayload(rawInput) {
  const trimmed = String(rawInput || '').trim();
  if (!trimmed) return null;

  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && parsed.type === 'member_id' && parsed.orgId && parsed.token) {
        return {
          kind: 'member_qr',
          orgId: String(parsed.orgId).trim(),
          token: String(parsed.token).trim(),
        };
      }
      if (parsed && parsed.sessionId && parsed.token) {
        return {
          kind: 'session_qr',
          orgId: parsed.orgId ? String(parsed.orgId).trim() : '',
          sessionId: String(parsed.sessionId).trim(),
          token: String(parsed.token).trim(),
          exp: Number(parsed.exp || 0),
        };
      }
    } catch {
      return null;
    }
  }

  if (/^SA-[A-Z0-9]{5,12}-[A-Z0-9]{4,12}$/i.test(trimmed)) {
    return {
      kind: 'member_public_id',
      memberPublicId: trimmed.toUpperCase(),
    };
  }

  if (trimmed.includes(':')) {
    const [sessionId, token] = trimmed.split(':').map((s) => s.trim());
    if (sessionId && token) {
      return { kind: 'session_qr', sessionId, token, exp: 0 };
    }
  }

  return null;
}

/**
 * Computes distance in meters between two WGS84 coordinates (Haversine formula).
 */
export function haversineDistanceMeters(lat1, lng1, lat2, lng2) {
  const toRad = (deg) => (Number(deg) * Math.PI) / 180;
  const R = 6371000;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return Math.round(R * c);
}

export function evaluateGeofence(geofenceConfig, coords) {
  if (!geofenceConfig?.enabled) {
    return { allowed: true, checked: false, distanceMeters: 0 };
  }
  if (
    coords == null ||
    Number.isNaN(Number(coords.lat)) ||
    Number.isNaN(Number(coords.lng))
  ) {
    return {
      allowed: false,
      checked: true,
      reason: 'Location permission is required by your organization geofencing policy to verify attendance.',
    };
  }
  const dist = haversineDistanceMeters(
    Number(geofenceConfig.lat),
    Number(geofenceConfig.lng),
    Number(coords.lat),
    Number(coords.lng)
  );
  const radius = Math.max(25, Number(geofenceConfig.radiusMeters) || 150);
  if (dist > radius) {
    return {
      allowed: false,
      checked: true,
      distanceMeters: dist,
      radiusMeters: radius,
      reason: `Outside allowed organization geofence (${dist}m away, max ${radius}m).`,
    };
  }
  return {
    allowed: true,
    checked: true,
    distanceMeters: dist,
    radiusMeters: radius,
  };
}
