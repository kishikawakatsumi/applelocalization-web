// CI-side SSH transport. No deployment secrets are copied to the VPS bundle.
import { execFileSync, spawn } from "node:child_process";
import { mkdtemp, mkdir, copyFile, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export function deploymentSpec(env) {
  const action = env.DEPLOY_ACTION;
  if (!["preflight", "prepare", "check", "publish", "rollback", "proxy-install", "proxy-status", "maintenance", "resume"].includes(action)) throw Error("Invalid action");
  const id = env.DEPLOY_ID;
  if (!/^[a-z][a-z0-9-]{0,30}$/.test(id ?? "")) throw Error("Invalid deployment ID");
  const port = Number(env.DEPLOY_PORT || "8085");
  if (!Number.isInteger(port) || port < 1024 || port > 65535 || port === 8084) throw Error("Invalid port (8084 is reserved for the legacy Web)");
  const commit = env.GITHUB_SHA;
  if (!/^[a-f0-9]{40}$/.test(commit ?? "")) throw Error("Invalid source commit");
  const webImage = env.DEPLOY_WEB_IMAGE;
  if (action === "prepare" && !/^kishikawakatsumi\/applelocalization-web@sha256:[a-f0-9]{64}$/.test(webImage ?? "")) {
    throw Error("An immutable Web image is required");
  }
  return { action, id, port, commit, webImage, project: "al-next-" + id };
}

export function imageOverride(spec) {
  return { services: {
    prepare: { environment: { LOCALIZATION_RESTORE_PROFILE: "vps-4g" } },
    db: {
      mem_limit: "2304m", memswap_limit: "2304m", cpus: 2,
      command: ["postgres", "-c", "shared_buffers=128MB", "-c", "work_mem=4MB",
        "-c", "maintenance_work_mem=64MB", "-c", "autovacuum_work_mem=32MB",
        "-c", "autovacuum_max_workers=1", "-c", "max_connections=40",
        "-c", "max_parallel_maintenance_workers=0", "-c", "max_parallel_workers_per_gather=0"],
    },
    setup: { image: spec.webImage, platform: "linux/amd64", mem_limit: "384m", memswap_limit: "384m" },
    web: { image: spec.webImage, platform: "linux/amd64", mem_limit: "384m", memswap_limit: "384m" },
  }};
}

async function main() {
  const spec = deploymentSpec(process.env);
  const host = process.env.SSH_HOST, user = process.env.SSH_USER;
  if (!/^[A-Za-z0-9][A-Za-z0-9.-]*$/.test(host ?? "") || !/^[a-z_][a-z0-9_-]*$/.test(user ?? "")) throw Error("Invalid SSH host/user");
  const sshPort = process.env.SSH_PORT || "22";
  if (!/^\d+$/.test(sshPort) || Number(sshPort) < 1 || Number(sshPort) > 65535) throw Error("Invalid SSH port");
  const args = ["-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", "ConnectTimeout=20", "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=3", "-p", sshPort, `${user}@${host}`];
  const proxyAction = ["publish", "rollback", "proxy-status", "maintenance", "resume"].includes(spec.action);
  const script = await readFile(proxyAction ? "deploy/proxy-vps.py" : "deploy/vps.sh");
  if (proxyAction) {
    execFileSync("ssh", [...args, `python3 - ${spec.action} ${spec.id}`], {input: script, stdio:["pipe","inherit","inherit"],timeout:20*60*1000});
    return;
  }
  const run = (mode) => execFileSync("ssh", [...args, `bash -s -- ${mode} ${spec.id}`], { input: script, stdio: ["pipe", "inherit", "inherit"], timeout: 20 * 60 * 1000 });
  const installingProxy = spec.action === "proxy-install";
  if (!installingProxy && spec.action !== "prepare") { run(spec.action); return; }
  if (!installingProxy) run("preflight");
  const root = await mkdtemp(join(tmpdir(), "localization-deploy-"));
  await mkdir(join(root, "deploy"));
  let files;
  if (installingProxy) {
    files = ["compose.proxy.yml", "maintenance.html", "proxy-vps.py"];
    for (const file of files) await copyFile("deploy/" + file, join(root, file));
  } else {
    for (const file of ["compose.yml", "deploy/prepare.sh", "deploy/vps.sh", "deploy/check-vps.py", "deploy/guarded-up.py"]) await copyFile(file, join(root, file));
    await writeFile(join(root, "images.json"), JSON.stringify(imageOverride(spec)));
    await writeFile(join(root, "deployment.json"), JSON.stringify(spec));
    files = ["compose.yml", "images.json", "deployment.json", "deploy"];
  }
  const archive = join(root, "deployment.tar");
  execFileSync("tar", ["-cf", archive, "-C", root, ...files]);
  // ID is strictly validated above. A fresh directory is mandatory; never overwrite.
  const directory = installingProxy ? '"$HOME/applelocalization-proxy"' : `"$HOME/applelocalization-deployments/${spec.id}"`;
  const launch = installingProxy ? `python3 ${directory}/proxy-vps.py proxy-install ${spec.id}` : `(nohup bash ${directory}/deploy/vps.sh worker ${spec.id} > ${directory}/deploy.log 2>&1 < /dev/null &)`;
  const command = `umask 077; mkdir -p "$HOME/applelocalization-deployments" && mkdir ${directory} && tar -xf - -C ${directory} && ${launch}`;
  await new Promise((resolve, reject) => {
    const child = spawn("ssh", [...args, command], { stdio: ["pipe", "inherit", "inherit"] });
    child.on("error", reject);
    child.on("exit", code => code === 0 ? resolve() : reject(Error(`SSH transfer failed (${code}); retain the directory for investigation and use a new deployment ID`)));
    child.stdin.on("error", reject);
    readFile(archive).then(bytes => child.stdin.end(bytes), reject);
  });
  console.log(installingProxy ? "HTTP proxy installed; legacy Web remains the upstream." : `Preparation launched, NOT published. Run check for ${spec.id}; SSH completion does not mean the DB is ready.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => { console.error(error.message); process.exitCode = 1; });
