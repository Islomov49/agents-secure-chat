import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { userInfo } from "node:os";
import { basename, join } from "node:path";
import type { ClientKind, Profile } from "@lincor/core";

const git = (cwd: string, ...args: string[]): string | undefined => {
  try {
    return execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "ignore"], timeout: 3000 }).toString().trim() || undefined;
  } catch {
    return undefined;
  }
};

/** The project an identity belongs to: the git root of `cwd`, else `cwd` itself. */
export function projectDirFor(cwd: string, env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.LINCOR_PROJECT_DIR || env.CLAUDE_PROJECT_DIR;
  const base = explicit || cwd;
  const root = git(base, "rev-parse", "--show-toplevel") ?? base;
  try {
    return realpathSync(root);
  } catch {
    return root;
  }
}

export function detectClient(env: NodeJS.ProcessEnv = process.env): ClientKind {
  if (env.LINCOR_CLIENT) return env.LINCOR_CLIENT as ClientKind;
  if (env.CLAUDECODE === "1" || env.CLAUDE_CODE_SESSION_ID) return "claude-code";
  if (Object.keys(env).some((k) => k.startsWith("CODEX_"))) return "codex";
  return "cli";
}

const readJson = (path: string): Record<string, unknown> | undefined => {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
};

interface StackGuess {
  stack: string[];
  role?: string;
  project?: string;
}

/** Best-effort stack and role from files in the project root. */
export function detectStack(dir: string): StackGuess {
  const has = (p: string) => existsSync(join(dir, p));
  const stack: string[] = [];
  let role: string | undefined;
  let project: string | undefined;

  if (has("ProjectSettings/ProjectVersion.txt")) {
    const version = readFileSync(join(dir, "ProjectSettings/ProjectVersion.txt"), "utf8").match(/m_EditorVersion:\s*(\S+)/)?.[1];
    stack.push(version ? `Unity ${version}` : "Unity");
    role = "unity";
  }
  if (has("project.godot")) {
    stack.push("Godot");
    role ??= "game";
  }
  const pkg = readJson(join(dir, "package.json"));
  if (pkg) {
    project = typeof pkg.name === "string" ? pkg.name : undefined;
    const deps = { ...(pkg.dependencies as object), ...(pkg.devDependencies as object) } as Record<string, string>;
    const known: [string, string, string][] = [
      ["next", "Next.js", "frontend"],
      ["react", "React", "frontend"],
      ["vue", "Vue", "frontend"],
      ["svelte", "Svelte", "frontend"],
      ["@angular/core", "Angular", "frontend"],
      ["vite", "Vite", "frontend"],
      ["react-native", "React Native", "mobile"],
      ["expo", "Expo", "mobile"],
      ["express", "Express", "backend"],
      ["fastify", "Fastify", "backend"],
      ["@nestjs/core", "NestJS", "backend"],
      ["hono", "Hono", "backend"],
    ];
    for (const [dep, label, r] of known) {
      if (deps[dep]) {
        stack.push(label);
        role ??= r;
      }
    }
    if (deps.typescript) stack.push("TypeScript");
    if (!stack.length) stack.push("Node.js");
  }
  const mods: [string, string, string][] = [
    ["go.mod", "Go", "backend"],
    ["Cargo.toml", "Rust", "backend"],
    ["pyproject.toml", "Python", "backend"],
    ["requirements.txt", "Python", "backend"],
    ["pom.xml", "Java", "backend"],
    ["build.gradle", "JVM", "backend"],
    ["build.gradle.kts", "Kotlin", "backend"],
    ["Gemfile", "Ruby", "backend"],
    ["composer.json", "PHP", "backend"],
    ["pubspec.yaml", "Flutter", "mobile"],
    ["Package.swift", "Swift", "mobile"],
  ];
  for (const [file, label, r] of mods) {
    if (has(file) && !stack.includes(label)) {
      stack.push(label);
      role ??= r;
    }
  }
  if (!project) {
    for (const doc of ["CLAUDE.md", "AGENTS.md", "README.md"]) {
      try {
        const heading = readFileSync(join(dir, doc), "utf8").match(/^#\s+(.+)$/m)?.[1]?.trim();
        if (heading) {
          project = heading.slice(0, 60);
          break;
        }
      } catch {
        // no such file
      }
    }
  }
  try {
    if (readdirSync(dir).some((f) => f.endsWith(".xcodeproj"))) {
      stack.push("Xcode");
      role ??= "ios";
    }
  } catch {
    // unreadable directory
  }
  return { stack, role, project };
}

export interface ProfileOverrides {
  name?: string;
  role?: string;
  owner?: string;
  project?: string;
  repo?: string;
  stack?: string;
  status?: string;
}

/** Profile filled from the repository (PRD FR-4.2); explicit overrides win. */
export function autoProfile(projectDir: string, overrides: ProfileOverrides = {}, env: NodeJS.ProcessEnv = process.env): Profile {
  const guess = detectStack(projectDir);
  const owner = overrides.owner ?? env.LINCOR_OWNER ?? git(projectDir, "config", "user.name") ?? safeUser();
  const role = (overrides.role ?? guess.role ?? "developer").toLowerCase();
  const remote = git(projectDir, "remote", "get-url", "origin");
  const repo = overrides.repo ?? (remote ? basename(remote).replace(/\.git$/, "") : undefined);
  const profile: Profile = {
    name: overrides.name ?? defaultName(owner, role),
    role,
    owner,
    project: overrides.project ?? guess.project ?? basename(projectDir),
    client: detectClient(env),
    kind: "agent",
  };
  if (repo) profile.repo = repo;
  const stack = overrides.stack ?? guess.stack.join(", ");
  if (stack) profile.stack = stack;
  if (overrides.status) profile.status = overrides.status;
  return profile;
}

/** "Ali's frontend agent": the name an agent gets unless it or its user chose one. */
export const defaultName = (owner: string | undefined, role: string): string => `${(owner ?? "someone").split(/\s+/)[0]}'s ${role} agent`;

/** Applies profile changes; an auto-generated name follows a role change, a chosen name is kept. */
export function mergeProfile(base: Profile, overrides: ProfileOverrides): Profile {
  const next = { ...base, ...Object.fromEntries(Object.entries(overrides).filter(([, v]) => v !== undefined)) } as Profile;
  if (overrides.role && !overrides.name && base.name === defaultName(base.owner, base.role)) {
    next.name = defaultName(next.owner, next.role);
  }
  return next;
}

function safeUser(): string {
  try {
    return userInfo().username;
  } catch {
    return "someone";
  }
}
