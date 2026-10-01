// Short-lived synthetic containers only. No real dataset volume is mounted or removed.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { parseArgs, promisify } from "node:util";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { localDockerOnly } from "./load-occurrence-staging.mjs";

const exec = promisify(execFile);
export async function verifyImageGuards(
  { image, output, allowLocalGuardTests = false },
) {
  assert.equal(allowLocalGuardTests, true);
  assert.match(image ?? "", /^sha256:[a-f0-9]{64}$/);
  localDockerOnly();
  await writeFile(output, JSON.stringify({ status: "running", image }) + "\n", {
    flag: "wx",
  });
  const cases = [
    {
      name: "wrong-database",
      args: ["-e", "POSTGRES_DB=wrong_database"],
      command: [],
      code: 64,
      message: /database name is fixed/,
    },
    {
      name: "incomplete-volume",
      args: ["--entrypoint", "bash"],
      command: [
        "-c",
        'printf "16\\n" > /var/lib/postgresql/data/PG_VERSION; exec /usr/local/bin/localization-entrypoint.sh postgres',
      ],
      code: 65,
      message: /incomplete or different dataset/,
    },
    {
      name: "different-dataset",
      args: ["--entrypoint", "bash"],
      command: [
        "-c",
        'printf "16\\n" > /var/lib/postgresql/data/PG_VERSION; printf "wrong\\n" > /var/lib/postgresql/data/.localization-ready; exec /usr/local/bin/localization-entrypoint.sh postgres',
      ],
      code: 65,
      message: /incomplete or different dataset/,
    },
    {
      name: "corrupt-sql",
      args: ["--entrypoint", "bash"],
      command: [
        "-c",
        'printf "broken\\n" > /opt/localization/import.sql.gz; exec /usr/local/bin/localization-entrypoint.sh postgres',
      ],
      code: 1,
      message: /FAILED/,
    },
  ];
  const results = [];
  try {
    for (const c of cases) {
      let code = 0, log = "";
      try {
        const r = await exec("docker", [
          "run",
          "--rm",
          "--pull=never",
          "--platform=linux/amd64",
          "--network=none",
          "--memory=512m",
          ...c.args,
          image,
          ...c.command,
        ], { encoding: "utf8", timeout: 30000 });
        log = r.stdout + r.stderr;
      } catch (e) {
        code = e.code;
        log = (e.stdout ?? "") + (e.stderr ?? "");
      }
      assert.equal(code, c.code, `${c.name}: ${log}`);
      assert.match(log, c.message);
      assert.ok(
        !log.includes("database system is ready to accept connections"),
      );
      results.push({
        name: c.name,
        exitCode: code,
        rejectedBeforeServing: true,
      });
      console.log(JSON.stringify(results.at(-1)));
    }
    const result = {
      status: "durable-image-guards-verified",
      image,
      results,
      productionReady: false,
      published: false,
    };
    await writeFile(output, JSON.stringify(result, null, 2) + "\n");
    return result;
  } catch (error) {
    await writeFile(
      output,
      JSON.stringify(
        { status: "failed", image, results, error: String(error) },
        null,
        2,
      ) + "\n",
    );
    throw error;
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const { values: v } = parseArgs({
    options: {
      image: { type: "string" },
      output: { type: "string" },
      "allow-local-guard-tests": { type: "boolean", default: false },
    },
  });
  console.log(
    JSON.stringify(
      await verifyImageGuards({
        ...v,
        allowLocalGuardTests: v["allow-local-guard-tests"],
      }),
      null,
      2,
    ),
  );
}
