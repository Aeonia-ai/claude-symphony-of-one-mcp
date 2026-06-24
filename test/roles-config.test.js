// TDD: roles-config.test.js
// Tests for the ROLES_CONFIG env-var config-loading mechanism.
// Since role-templates.js reads config at module load, each case runs the module
// in a child process (spawn node --input-type=module) with the appropriate env.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO = new URL("..", import.meta.url).pathname;

function runInChild(code, env = {}) {
  const result = spawnSync(
    process.execPath,
    ["--input-type=module"],
    {
      input: code,
      env: { ...process.env, ...env },
      encoding: "utf8",
    }
  );
  if (result.status !== 0) {
    throw new Error(`Child exited ${result.status}: ${result.stderr}`);
  }
  return result.stdout.trim();
}

test("ROLES_CONFIG unset → generic default SENIOR_DEVELOPER present", () => {
  const out = runInChild(
    `import { getRole } from ${JSON.stringify(REPO + "role-templates.js")};
     const r = getRole("SENIOR_DEVELOPER");
     console.log(r ? "ok" : "missing");`
  );
  assert.equal(out, "ok");
});

test("ROLES_CONFIG unset → no KOS-specific roles present", () => {
  const out = runInChild(
    `import { getRole } from ${JSON.stringify(REPO + "role-templates.js")};
     const kosRoles = ["COMPANION", "COORDINATOR", "MU_PM", "SCRIBE"];
     const found = kosRoles.filter(k => getRole(k) !== undefined);
     console.log(found.length === 0 ? "clean" : "dirty:" + found.join(","));`
  );
  assert.equal(out, "clean");
});

test("ROLES_CONFIG set → custom role appears in getRoleNames()", () => {
  const fixture = join(tmpdir(), `roles-test-${process.pid}.json`);
  writeFileSync(fixture, JSON.stringify({
    roles: {
      CUSTOM_AGENT: {
        name: "Custom Agent",
        category: "Custom",
        description: "A test-only role.",
        prompt: "You are Custom Agent.",
        capabilities: ["testing"],
        defaultTasks: ["Run tests"],
        priority: "low",
      },
    },
  }));
  try {
    const out = runInChild(
      `import { getRoleNames } from ${JSON.stringify(REPO + "role-templates.js")};
       console.log(getRoleNames().includes("CUSTOM_AGENT") ? "found" : "missing");`,
      { ROLES_CONFIG: fixture }
    );
    assert.equal(out, "found");
  } finally {
    unlinkSync(fixture);
  }
});

test("ROLES_CONFIG set → default roles absent (overridden)", () => {
  const fixture = join(tmpdir(), `roles-test2-${process.pid}.json`);
  writeFileSync(fixture, JSON.stringify({
    roles: {
      ONLY_ROLE: {
        name: "Only Role",
        category: "Solo",
        description: "The only role.",
        prompt: "You are Only Role.",
        capabilities: ["solo"],
        defaultTasks: ["Do it alone"],
        priority: "medium",
      },
    },
  }));
  try {
    const out = runInChild(
      `import { getRoleNames } from ${JSON.stringify(REPO + "role-templates.js")};
       const names = getRoleNames();
       console.log(JSON.stringify(names));`,
      { ROLES_CONFIG: fixture }
    );
    const names = JSON.parse(out);
    assert.deepEqual(names, ["ONLY_ROLE"]);
  } finally {
    unlinkSync(fixture);
  }
});

test("ROLES_CONFIG set to invalid path → falls back to defaults", () => {
  const out = runInChild(
    `import { getRole } from ${JSON.stringify(REPO + "role-templates.js")};
     const r = getRole("SENIOR_DEVELOPER");
     console.log(r ? "ok" : "missing");`,
    { ROLES_CONFIG: "/nonexistent/path/roles.json" }
  );
  assert.equal(out, "ok");
});
