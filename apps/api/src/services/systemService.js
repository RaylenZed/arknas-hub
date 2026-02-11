import si from "systeminformation";

export async function getSystemStatus() {
  const [load, mem, fs, networkStats] = await Promise.all([
    si.currentLoad(),
    si.mem(),
    si.fsSize(),
    si.networkStats()
  ]);

  const disks = (fs || []).map((d) => ({
    fs: d.fs,
    mount: d.mount,
    size: d.size,
    used: d.used,
    available: Math.max(0, d.size - d.used),
    usePercent: d.use
  }));

  const net = (networkStats || []).map((n) => ({
    iface: n.iface,
    rxBytes: n.rx_bytes,
    txBytes: n.tx_bytes,
    rxSec: n.rx_sec,
    txSec: n.tx_sec
  }));

  return {
    cpu: {
      usagePercent: Number(load.currentLoad.toFixed(2)),
      cores: load.cpus?.length || 0
    },
    memory: {
      total: mem.total,
      used: mem.used,
      free: mem.free,
      usagePercent: Number(((mem.used / mem.total) * 100).toFixed(2))
    },
    disks,
    network: net,
    updatedAt: new Date().toISOString()
  };
}
