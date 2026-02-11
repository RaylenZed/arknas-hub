import { spawnSync } from "node:child_process";
import { config } from "../config.js";

function execCommand(command, args, timeoutMs = 10000) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    timeout: timeoutMs
  });

  const stdout = String(result.stdout || "").trim();
  const stderr = String(result.stderr || "").trim();
  const error = result.error ? String(result.error.message || result.error) : "";

  return {
    ok: result.status === 0,
    code: Number.isFinite(result.status) ? result.status : -1,
    stdout,
    stderr,
    error
  };
}

function hasCommand(cmd) {
  const checked = execCommand("sh", ["-lc", `command -v ${cmd}`], 3000);
  return checked.ok;
}

function wrapNsenterArgs(command, args) {
  return [
    "--target",
    "1",
    "--mount",
    "--uts",
    "--ipc",
    "--net",
    "--pid",
    "--",
    command,
    ...args
  ];
}

export function runHostCommand(command, args = [], timeoutMs = 10000) {
  const mode = String(config.hostExecMode || "nsenter").toLowerCase();

  if (mode === "nsenter") {
    if (!hasCommand("nsenter")) {
      return {
        ok: false,
        code: -1,
        stdout: "",
        stderr: "",
        error: "nsenter 不可用，请确认 API 镜像安装 util-linux 且容器具备权限",
        mode,
        command: `nsenter --target 1 --mount --uts --ipc --net --pid -- ${command} ${args.join(" ")}`.trim()
      };
    }
    const finalArgs = wrapNsenterArgs(command, args);
    const result = execCommand("nsenter", finalArgs, timeoutMs);
    return {
      ...result,
      mode,
      command: `nsenter ${finalArgs.join(" ")}`
    };
  }

  const result = execCommand(command, args, timeoutMs);
  return {
    ...result,
    mode: "direct",
    command: `${command} ${args.join(" ")}`.trim()
  };
}

export function hostCommandExists(command) {
  const res = runHostCommand("sh", ["-lc", `command -v ${command}`], 4000);
  return res.ok;
}

export function getHostExecStatus() {
  const mode = String(config.hostExecMode || "nsenter").toLowerCase();
  if (mode === "nsenter") {
    return {
      mode,
      nsenterAvailable: hasCommand("nsenter"),
      hint: "nsenter 模式需要容器具备 SYS_ADMIN / pid:host"
    };
  }
  return {
    mode,
    nsenterAvailable: hasCommand("nsenter"),
    hint: "direct 模式在容器命名空间执行命令"
  };
}
