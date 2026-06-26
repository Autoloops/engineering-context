import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { extname, join, resolve } from "node:path";
import Parser from "web-tree-sitter";
import {
  defaultWorkbenchDir,
  option,
  parseArgs,
  readJson,
  readTask,
  relativeTo,
  repoRawDirFor,
  taskDirFor,
  walkFiles,
  writeJson,
  type RepoSnapshotManifest,
} from "./lib.js";

interface SymbolRecord {
  file: string;
  name: string;
  symbol: string;
  node_type: string;
  start_line: number;
  end_line: number;
}

const require = createRequire(import.meta.url);

const wasmByExtension = new Map<string, string>([
  [".ts", "tree-sitter-typescript.wasm"],
  [".tsx", "tree-sitter-tsx.wasm"],
  [".mts", "tree-sitter-typescript.wasm"],
  [".cts", "tree-sitter-typescript.wasm"],
  [".js", "tree-sitter-javascript.wasm"],
  [".jsx", "tree-sitter-javascript.wasm"],
  [".mjs", "tree-sitter-javascript.wasm"],
  [".cjs", "tree-sitter-javascript.wasm"],
  [".py", "tree-sitter-python.wasm"],
  [".go", "tree-sitter-go.wasm"],
  [".rs", "tree-sitter-rust.wasm"],
  [".java", "tree-sitter-java.wasm"],
  [".c", "tree-sitter-c.wasm"],
  [".h", "tree-sitter-c.wasm"],
  [".cpp", "tree-sitter-cpp.wasm"],
  [".cc", "tree-sitter-cpp.wasm"],
  [".cxx", "tree-sitter-cpp.wasm"],
  [".hpp", "tree-sitter-cpp.wasm"],
  [".cs", "tree-sitter-c_sharp.wasm"],
  [".php", "tree-sitter-php.wasm"],
  [".rb", "tree-sitter-ruby.wasm"],
  [".swift", "tree-sitter-swift.wasm"],
  [".kt", "tree-sitter-kotlin.wasm"],
  [".kts", "tree-sitter-kotlin.wasm"],
  [".dart", "tree-sitter-dart.wasm"],
  [".scala", "tree-sitter-scala.wasm"],
  [".lua", "tree-sitter-lua.wasm"],
  [".m", "tree-sitter-objc.wasm"],
  [".mm", "tree-sitter-objc.wasm"],
  [".sh", "tree-sitter-bash.wasm"],
  [".bash", "tree-sitter-bash.wasm"],
  [".json", "tree-sitter-json.wasm"],
]);

const declarationNodeTypes = new Set([
  "class_declaration",
  "class_definition",
  "function_declaration",
  "function_definition",
  "method_definition",
  "method_declaration",
  "interface_declaration",
  "type_alias_declaration",
  "enum_declaration",
  "struct_item",
  "struct_declaration",
  "impl_item",
  "trait_item",
  "function_item",
  "method_elem",
  "method_declaration",
  "method_definition",
  "type_declaration",
  "const_item",
  "var_declaration",
  "const_declaration",
  "variable_declarator",
  "lexical_declaration",
]);

const containerNodeTypes = new Set([
  "class_declaration",
  "class_definition",
  "interface_declaration",
  "struct_item",
  "struct_declaration",
  "impl_item",
  "trait_item",
  "type_declaration",
]);

try {
  await main();
} catch (error: unknown) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const workbenchDir = resolve(option(args, "--workbench") ?? defaultWorkbenchDir);
  const taskDir = resolve(option(args, "--task-dir") ?? taskDirFor(readTaskFromArgs(args), workbenchDir));
  const task = readTask(taskDir);
  const rawRepoDir = join(repoRawDirFor(task, workbenchDir), "repo", task.base_commit);
  const snapshot = readJson<RepoSnapshotManifest>(join(rawRepoDir, "manifest.json"));
  const checkoutDir = snapshot.checkout_dir;
  if (!existsSync(checkoutDir)) throw new Error(`Checkout does not exist: ${checkoutDir}`);

  await Parser.init({
    locateFile: () => require.resolve("web-tree-sitter/tree-sitter.wasm"),
  });

  const languageCache = new Map<string, Promise<Parser.Language>>();
  const records: SymbolRecord[] = [];
  const unsupportedExtensions = new Set<string>();

  for (const filePath of walkFiles(checkoutDir, { maxBytes: 1_000_000 })) {
    const ext = extname(filePath).toLowerCase();
    const wasm = wasmByExtension.get(ext);
    if (wasm === undefined) {
      unsupportedExtensions.add(ext || "<none>");
      continue;
    }
    try {
      const language = await loadLanguage(wasm, languageCache);
      const parser = new Parser();
      parser.setLanguage(language);
      const tree = parser.parse(readFileSync(filePath, "utf8"));
      records.push(...collectSymbols(tree.rootNode, relativeTo(checkoutDir, filePath)));
      tree.delete();
      parser.delete();
    } catch {
      unsupportedExtensions.add(ext);
    }
  }

  records.sort((left, right) => left.file.localeCompare(right.file) || left.start_line - right.start_line);
  const symbolsPath = join(rawRepoDir, "symbols.json");
  writeJson(symbolsPath, {
    repo: task.repo,
    base_commit: task.base_commit,
    symbol_count: records.length,
    unsupported_extensions: [...unsupportedExtensions].sort(),
    symbols: records,
  });
  writeJson(join(taskDir, "evidence", "symbols.manifest.json"), {
    symbols_path: symbolsPath,
    symbol_count: records.length,
    unsupported_extension_count: unsupportedExtensions.size,
  });

  console.log(`Extracted symbols: ${records.length}`);
  console.log(`Symbols: ${symbolsPath}`);
}

function readTaskFromArgs(args: Map<string, string | true>) {
  const taskId = option(args, "--task");
  if (taskId === undefined) throw new Error("Usage: extract-symbols --task-dir <dir> or --task <task-id>");
  return {
    task_id: taskId,
    repo: option(args, "--repo") ?? "cli/cli",
    repo_url: "",
    base_commit: "",
    cutoff: "",
  };
}

async function loadLanguage(wasmFile: string, cache: Map<string, Promise<Parser.Language>>): Promise<Parser.Language> {
  const cached = cache.get(wasmFile);
  if (cached !== undefined) return cached;
  const loaded = Parser.Language.load(join(require.resolve("tree-sitter-wasms/package.json"), "..", "out", wasmFile));
  cache.set(wasmFile, loaded);
  return loaded;
}

function collectSymbols(root: Parser.SyntaxNode, file: string): SymbolRecord[] {
  const symbols: SymbolRecord[] = [];
  walk(root, [], file, symbols);
  return symbols;
}

function walk(node: Parser.SyntaxNode, containers: string[], file: string, symbols: SymbolRecord[]): void {
  const name = nameForNode(node);
  const isDeclaration = declarationNodeTypes.has(node.type);
  if (isDeclaration && name !== undefined) {
    const symbol = [...containers, name].join(".");
    symbols.push({
      file,
      name,
      symbol,
      node_type: node.type,
      start_line: node.startPosition.row + 1,
      end_line: Math.max(node.startPosition.row + 1, node.endPosition.row + 1),
    });
  }

  const childContainers = containerNodeTypes.has(node.type) && name !== undefined ? [...containers, name] : containers;
  for (const child of node.namedChildren) walk(child, childContainers, file, symbols);
}

function nameForNode(node: Parser.SyntaxNode): string | undefined {
  const byField = node.childForFieldName("name");
  if (byField !== null && byField.text.trim().length > 0) return byField.text;

  if (node.type === "variable_declarator") {
    const first = node.firstNamedChild;
    if (first !== null && first.text.trim().length > 0) return first.text;
  }

  if (node.type === "const_item" || node.type === "const_declaration" || node.type === "var_declaration") {
    const identifier = firstIdentifierName(node);
    if (identifier !== undefined) return identifier;
  }

  return undefined;
}

function firstIdentifierName(node: Parser.SyntaxNode): string | undefined {
  for (const child of node.namedChildren) {
    if (child.type === "identifier" || child.type === "type_identifier") {
      const text = child.text.trim();
      if (text.length > 0) return text;
    }

    const nested = firstIdentifierName(child);
    if (nested !== undefined) return nested;
  }

  return undefined;
}
