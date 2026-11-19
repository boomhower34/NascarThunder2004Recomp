// upnp.mjs — ask the home router to forward a port (UPnP IGD), so a host can be reached without the player setting
// up port forwarding. Pure Node: SSDP discovery (UDP multicast 239.255.255.250:1900), the router's description XML,
// then SOAP calls on its WANIPConnection / WANPPPConnection service: GetExternalIPAddress, AddPortMapping,
// DeletePortMapping. Routers with UPnP turned off, double NAT and carrier-grade NAT cannot be helped this way
// (mapped() then says why); the relay is the way in for those.
//
//   const m = await upnpMap({ port: 27104, protocol: "TCP", description: "NT04 online" });
//   m.ok, m.external ("203.0.113.5"), m.reason; m.close() removes the mapping (also renewed every 20 minutes)
//
// NT04_UPNP_LOCATION=http://host:port/desc.xml skips discovery (tests, or a router that does not answer M-SEARCH).

import { createSocket } from "node:dgram";
import { networkInterfaces } from "node:os";

const SSDP = { host: "239.255.255.250", port: 1900 };
const SERVICES = ["urn:schemas-upnp-org:service:WANIPConnection:2", "urn:schemas-upnp-org:service:WANIPConnection:1", "urn:schemas-upnp-org:service:WANPPPConnection:1"];
const LEASE = 3600, RENEW_MS = 20 * 60 * 1000;

const tag = (xml, name) => { const m = new RegExp(`<(?:\\w+:)?${name}>([^<]*)</(?:\\w+:)?${name}>`, "i").exec(xml); return m ? m[1].trim() : null; };

// SSDP M-SEARCH for an Internet Gateway Device; resolves the first LOCATION (description URL) or null
function discover(timeout = 2500) {
  return new Promise(resolve => {
    const s = createSocket({ type: "udp4", reuseAddr: true }); let done = false;
    const finish = v => { if (done) return; done = true; clearTimeout(t); try { s.close(); } catch {} resolve(v); };
    const t = setTimeout(() => finish(null), timeout);
    s.on("error", () => finish(null));
    s.on("message", msg => { const loc = /^location:\s*(\S+)/im.exec(msg.toString()); if (loc && /InternetGatewayDevice|WAN(IP|PPP)Connection/i.test(msg.toString())) finish(loc[1]); });
    s.bind(0, () => {
      for (const st of ["urn:schemas-upnp-org:device:InternetGatewayDevice:1", ...SERVICES]) {
        const q = Buffer.from(`M-SEARCH * HTTP/1.1\r\nHOST: ${SSDP.host}:${SSDP.port}\r\nMAN: "ssdp:discover"\r\nMX: 2\r\nST: ${st}\r\n\r\n`);
        s.send(q, SSDP.port, SSDP.host, () => {});
      }
    });
  });
}

// the WAN connection service's control URL from the device description
async function service(location) {
  const xml = await (await fetch(location, { signal: AbortSignal.timeout(4000) })).text();
  for (const type of SERVICES) {
    const i = xml.indexOf(type); if (i < 0) continue;
    const block = xml.slice(i, xml.indexOf("</service>", i));
    const ctl = tag(block, "controlURL"); if (ctl) return { type, url: new URL(ctl, location).href };
  }
  return null;
}

async function soap(svc, action, args = {}) {
  const body = `<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body><u:${action} xmlns:u="${svc.type}">${Object.entries(args).map(([k, v]) => `<${k}>${v}</${k}>`).join("")}</u:${action}></s:Body></s:Envelope>`;
  const r = await fetch(svc.url, { method: "POST", body, headers: { "content-type": 'text/xml; charset="utf-8"', soapaction: `"${svc.type}#${action}"` }, signal: AbortSignal.timeout(4000) });
  const text = await r.text();
  if (!r.ok) throw new Error(`${action}: ${tag(text, "errorDescription") ?? `HTTP ${r.status}`}${tag(text, "errorCode") ? ` (${tag(text, "errorCode")})` : ""}`);
  return text;
}

// this machine's LAN address on the router's network (the interface that can reach the router's address)
function localAddress(routerHost) {
  const all = Object.values(networkInterfaces()).flat().filter(a => a && a.family === "IPv4" && !a.internal);
  const same = all.find(a => { const p = a.address.split("."), q = routerHost.split("."); return p[0] === q[0] && p[1] === q[1] && p[2] === q[2]; });
  return (same ?? all[0])?.address ?? null;
}
const privateV4 = ip => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|127\.|169\.254\.|0\.)/.test(ip);

export async function upnpMap({ port, protocol = "TCP", description = "NT04 online", log = () => {} } = {}) {
  const res = { ok: false, external: null, reason: null, close: async () => {} };
  try {
    const location = process.env.NT04_UPNP_LOCATION || await discover();
    if (!location) { res.reason = "no UPnP router answered (UPnP may be off on the router)"; return res; }
    const svc = await service(location); if (!svc) { res.reason = "the router has no WAN connection service"; return res; }
    const routerHost = new URL(location).hostname, client = process.env.NT04_UPNP_CLIENT || localAddress(routerHost);
    if (!client) { res.reason = "no local network address"; return res; }
    const add = () => soap(svc, "AddPortMapping", { NewRemoteHost: "", NewExternalPort: port, NewProtocol: protocol, NewInternalPort: port, NewInternalClient: client, NewEnabled: 1, NewPortMappingDescription: description, NewLeaseDuration: LEASE });
    try { await add(); }
    catch (e) {   // some routers refuse leases: ask for a permanent mapping (removed in close)
      if (/725|OnlyPermanentLeases/i.test(e.message)) await soap(svc, "AddPortMapping", { NewRemoteHost: "", NewExternalPort: port, NewProtocol: protocol, NewInternalPort: port, NewInternalClient: client, NewEnabled: 1, NewPortMappingDescription: description, NewLeaseDuration: 0 });
      else throw e;
    }
    res.external = tag(await soap(svc, "GetExternalIPAddress"), "NewExternalIPAddress");
    res.ok = true;
    if (res.external && privateV4(res.external)) { res.reason = `the router's own internet address ${res.external} is private: another router or the provider's NAT sits in front, so the mapping does not reach the internet`; res.ok = false; }
    const timer = setInterval(() => add().catch(e => log(`upnp renew: ${e.message}`)), RENEW_MS); timer.unref?.();
    res.close = async () => { clearInterval(timer); try { await soap(svc, "DeletePortMapping", { NewRemoteHost: "", NewExternalPort: port, NewProtocol: protocol }); } catch {} };
    log(`upnp: ${protocol} ${port} -> ${client}:${port} on ${routerHost}${res.external ? `, internet address ${res.external}` : ""}`);
  } catch (e) { res.reason = `the router refused: ${e.message}`; }
  return res;
}
export const _test = { tag, privateV4 };
