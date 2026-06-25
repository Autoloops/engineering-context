import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { extname, join, normalize, relative } from "node:path";
import Parser from "web-tree-sitter";
import type { ClaimCodeAnchor } from "../claim.js";
import type { ResolvedCodeAnchor } from "./types.js";

interface SymbolCandidate {
  name: string;
  symbol: string;
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

const cFamilyExtensions = new Set([
  ".c",
  ".cc",
  ".cpp",
  ".cxx",
  ".h",
  ".hh",
  ".hpp",
  ".hxx",
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

export class CodeAnchorResolver {
  private parserReady: Promise<void> | undefined;
  private readonly languageCache = new Map<string, Promise<Parser.Language>>();
  private readonly fileSymbolCache = new Map<string, SymbolCandidate[] | undefined>();

  async resolve(repoRoot: string | undefined, anchor: ClaimCodeAnchor): Promise<ResolvedCodeAnchor> {
    if (repoRoot === undefined) {
      return { ...anchor, status: "missing_file" };
    }

    const filePath = join(repoRoot, anchor.file);
    if (!isRepoRelative(repoRoot, filePath) || !existsSync(filePath)) {
      return { ...anchor, status: "missing_file" };
    }

    if (anchor.symbol === undefined) {
      return { ...anchor, status: "file_only" };
    }

    const symbols = await this.symbolsForFile(filePath);
    if (symbols === undefined) {
      const fallback = fallbackSymbolForFile(filePath, anchor.symbol);
      if (fallback !== undefined) {
        return {
          ...anchor,
          start_line: fallback.start_line,
          status: "resolved",
        };
      }
      return { ...anchor, status: "unsupported_language" };
    }

    const matches = symbols.filter((candidate) => candidate.symbol === anchor.symbol || candidate.name === anchor.symbol);
    if (matches.length === 0) {
      const fallback = fallbackSymbolForFile(filePath, anchor.symbol);
      if (fallback !== undefined) {
        return {
          ...anchor,
          start_line: fallback.start_line,
          status: "resolved",
        };
      }
      return { ...anchor, status: "missing_symbol" };
    }
    if (matches.length > 1) {
      return { ...anchor, status: "ambiguous_symbol" };
    }

    const match = matches[0];
    return {
      ...anchor,
      start_line: match.start_line,
      end_line: match.end_line,
      status: "resolved",
    };
  }

  async resolveMany(repoRoot: string | undefined, anchors: ClaimCodeAnchor[] | undefined): Promise<ResolvedCodeAnchor[]> {
    const resolved: ResolvedCodeAnchor[] = [];
    for (const anchor of anchors ?? []) {
      resolved.push(await this.resolve(repoRoot, anchor));
    }
    return resolved;
  }

  private async symbolsForFile(filePath: string): Promise<SymbolCandidate[] | undefined> {
    const cached = this.fileSymbolCache.get(filePath);
    if (cached !== undefined || this.fileSymbolCache.has(filePath)) return cached;

    const wasmFile = wasmByExtension.get(extname(filePath).toLowerCase());
    if (wasmFile === undefined) {
      this.fileSymbolCache.set(filePath, undefined);
      return undefined;
    }

    try {
      const language = await this.loadLanguage(wasmFile);
      const parser = new Parser();
      parser.setLanguage(language);
      const tree = parser.parse(readFileSync(filePath, "utf8"));
      const symbols = collectSymbols(tree.rootNode);
      tree.delete();
      parser.delete();
      this.fileSymbolCache.set(filePath, symbols);
      return symbols;
    } catch {
      this.fileSymbolCache.set(filePath, undefined);
      return undefined;
    }
  }

  private async loadLanguage(wasmFile: string): Promise<Parser.Language> {
    await this.ensureParserReady();
    const cached = this.languageCache.get(wasmFile);
    if (cached !== undefined) return cached;

    const language = Parser.Language.load(join(require.resolve("tree-sitter-wasms/package.json"), "..", "out", wasmFile));
    this.languageCache.set(wasmFile, language);
    return language;
  }

  private ensureParserReady(): Promise<void> {
    this.parserReady ??= Parser.init({
      locateFile: () => require.resolve("web-tree-sitter/tree-sitter.wasm"),
    });
    return this.parserReady;
  }
}

function fallbackSymbolForFile(filePath: string, symbol: string): SymbolCandidate | undefined {
  if (!cFamilyExtensions.has(extname(filePath).toLowerCase())) return undefined;

  const line = findCFamilySymbolLine(readFileSync(filePath, "utf8"), symbol);
  if (line === undefined) return undefined;

  return {
    name: symbol,
    symbol,
    start_line: line,
    end_line: line,
  };
}

function findCFamilySymbolLine(source: string, symbol: string): number | undefined {
  const needles = symbolNeedles(symbol);
  if (needles.length === 0) return undefined;

  let best: { line: number; score: number } | undefined;
  const lines = source.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const rawLine = lines[index] ?? "";
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("//")) continue;

    for (const needle of needles) {
      const score = cFamilyLineScore(line, needle);
      if (score === 0) continue;
      const candidate = { line: index + 1, score };
      if (best === undefined || candidate.score > best.score) best = candidate;
    }
  }

  return best?.line;
}

function symbolNeedles(symbol: string): string[] {
  const normalized = symbol.trim();
  if (normalized.length === 0) return [];

  const needles = new Set<string>([normalized]);
  const unqualified = lastQualifiedSegment(normalized);
  if (unqualified !== undefined && unqualified.length > 0) needles.add(unqualified);

  for (const part of normalized.split(/\s*(?:\/|\||\band\b)\s*/i)) {
    if (part.length > 0) needles.add(part);
  }

  return [...needles].filter((needle) => needle.length >= 3).sort((left, right) => right.length - left.length);
}

function lastQualifiedSegment(symbol: string): string | undefined {
  let depth = 0;
  let lastQualifier = -1;
  for (let index = 0; index < symbol.length - 1; index += 1) {
    const char = symbol[index];
    if (char === "<") depth += 1;
    else if (char === ">") depth = Math.max(0, depth - 1);
    else if (depth === 0 && char === ":" && symbol[index + 1] === ":") lastQualifier = index;
  }

  if (lastQualifier === -1) return undefined;
  return symbol.slice(lastQualifier + 2).trim();
}

function cFamilyLineScore(line: string, symbol: string): number {
  const normalizedLine = normalizeWhitespace(line);
  const normalizedSymbol = normalizeWhitespace(symbol);

  if (normalizedLine.includes(normalizedSymbol)) {
    const definitionScore = cFamilyDefinitionScore(normalizedLine, normalizedSymbol);
    if (definitionScore !== undefined) return definitionScore;
    return declarationLikeLine(line) ? 100 : 70;
  }

  const escaped = escapeRegex(symbol);
  const declarationPatterns = [
    new RegExp(String.raw`\b(?:class|struct|enum|union|using|typedef)\s+${escaped}\b`),
    new RegExp(String.raw`\b(?:auto|constexpr|consteval|constinit|static|inline|virtual|explicit|friend|extern)\b.*\b${escaped}\s*(?:\(|=|;)`),
    new RegExp(String.raw`\b${escaped}\s*(?:\(|=|;)`),
    new RegExp(String.raw`(?:^|::)\s*${escaped}\s*\(`),
  ];

  if (declarationPatterns.some((pattern) => pattern.test(line))) {
    return declarationLikeLine(line) ? 60 : 40;
  }

  return 0;
}

function cFamilyDefinitionScore(line: string, symbol: string): number | undefined {
  const escaped = escapeRegex(symbol);
  if (new RegExp(String.raw`\b(?:class|struct|enum|union|using|typedef)\s+${escaped}`).test(line)) {
    return 130;
  }

  const index = line.indexOf(symbol);
  if (index === -1) return undefined;

  const before = line.slice(0, index);
  const after = line.slice(index + symbol.length);
  if (after.trimStart().startsWith("(") && !before.includes("=")) {
    return 120;
  }

  return undefined;
}

function declarationLikeLine(line: string): boolean {
  return /\b(?:class|struct|enum|union|using|typedef|template|auto|constexpr|consteval|constinit|static|inline|virtual|explicit|friend|extern)\b/.test(line) ||
    /[({;=]\s*(?:const\s*)?(?:noexcept\s*)?(?:override\s*)?(?:final\s*)?;?\s*$/.test(line);
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function collectSymbols(root: Parser.SyntaxNode): SymbolCandidate[] {
  const symbols: SymbolCandidate[] = [];
  walk(root, [], symbols);
  return symbols.sort((left, right) => left.symbol.localeCompare(right.symbol) || left.start_line - right.start_line);
}

function walk(node: Parser.SyntaxNode, containers: string[], symbols: SymbolCandidate[]): void {
  const name = nameForNode(node);
  const isDeclaration = declarationNodeTypes.has(node.type);
  if (isDeclaration && name !== undefined) {
    const symbol = [...containers, name].join(".");
    symbols.push({
      name,
      symbol,
      start_line: node.startPosition.row + 1,
      end_line: Math.max(node.startPosition.row + 1, node.endPosition.row + 1),
    });
  }

  const childContainers = containerNodeTypes.has(node.type) && name !== undefined ? [...containers, name] : containers;
  for (const child of node.namedChildren) {
    walk(child, childContainers, symbols);
  }
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

function isRepoRelative(repoRoot: string, filePath: string): boolean {
  const relativePath = normalize(relative(repoRoot, filePath));
  return relativePath.length === 0 || (!relativePath.startsWith("..") && !relativePath.startsWith("/"));
}
