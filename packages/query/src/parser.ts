import type { QueryBooleanNode, QueryConditionNode, QueryNode, QueryNotNode, QueryOperator, QueryTextNode } from "@aevo/contracts";

type TokenKind = "word" | "string" | "operator" | "colon" | "lparen" | "rparen" | "eof";

interface Token {
  kind: TokenKind;
  value: string;
  position: number;
}

const comparisonOperators: Readonly<Record<string, QueryOperator>> = {
  "=": "eq",
  "!=": "neq",
  ">": "gt",
  ">=": "gte",
  "<": "lt",
  "<=": "lte"
};

function isWhitespace(character: string): boolean {
  return /\s/u.test(character);
}

function isOperatorStart(character: string): boolean {
  return character === "=" || character === "!" || character === ">" || character === "<";
}

function readQuoted(input: string, start: number): { value: string; next: number } {
  const quote = input[start];
  let value = "";
  let cursor = start + 1;

  while (cursor < input.length) {
    const character = input[cursor];
    if (character === "\\" && cursor + 1 < input.length) {
      value += input[cursor + 1];
      cursor += 2;
      continue;
    }
    if (character === quote) return { value, next: cursor + 1 };
    value += character;
    cursor += 1;
  }

  throw new QuerySyntaxError("Unterminated quoted value", start);
}

export function lexQuery(input: string): Token[] {
  const tokens: Token[] = [];
  let cursor = 0;

  while (cursor < input.length) {
    const character = input[cursor];
    if (isWhitespace(character)) {
      cursor += 1;
      continue;
    }
    if (character === "(") {
      tokens.push({ kind: "lparen", value: character, position: cursor });
      cursor += 1;
      continue;
    }
    if (character === ")") {
      tokens.push({ kind: "rparen", value: character, position: cursor });
      cursor += 1;
      continue;
    }
    if (character === ":") {
      tokens.push({ kind: "colon", value: character, position: cursor });
      cursor += 1;
      continue;
    }
    if (character === "\"" || character === "'") {
      const quoted = readQuoted(input, cursor);
      tokens.push({ kind: "string", value: quoted.value, position: cursor });
      cursor = quoted.next;
      continue;
    }
    if (isOperatorStart(character)) {
      const start = cursor;
      cursor += 1;
      if (cursor < input.length && input[cursor] === "=") cursor += 1;
      tokens.push({ kind: "operator", value: input.slice(start, cursor), position: start });
      continue;
    }

    const start = cursor;
    while (cursor < input.length) {
      const current = input[cursor];
      if (isWhitespace(current) || current === "(" || current === ")" || current === ":" || isOperatorStart(current) || current === "\"" || current === "'") break;
      cursor += 1;
    }
    if (cursor === start) throw new QuerySyntaxError(`Unexpected character '${character}'`, cursor);
    tokens.push({ kind: "word", value: input.slice(start, cursor), position: start });
  }

  tokens.push({ kind: "eof", value: "", position: input.length });
  return tokens;
}

export class QuerySyntaxError extends Error {
  readonly position: number;

  constructor(message: string, position: number) {
    super(message);
    this.name = "QuerySyntaxError";
    this.position = position;
  }
}

function textNode(value: string): QueryTextNode {
  return { type: "text", value };
}

function booleanNode(type: "and" | "or", children: QueryNode[]): QueryNode {
  if (children.length === 1) return children[0];
  return { type, children } satisfies QueryBooleanNode;
}

function notNode(child: QueryNode): QueryNotNode {
  return { type: "not", child };
}

function isKeyword(token: Token, keyword: string): boolean {
  return token.kind === "word" && token.value.toUpperCase() === keyword;
}

function startsPrimary(token: Token): boolean {
  if (isKeyword(token, "AND") || isKeyword(token, "OR")) return false;
  return token.kind === "word" || token.kind === "string" || token.kind === "lparen" || isKeyword(token, "NOT");
}

class QueryParser {
  private cursor = 0;

  constructor(private readonly tokens: Token[]) {}

  parse(): QueryNode | null {
    if (this.peek().kind === "eof") return null;
    const node = this.parseOr();
    const trailing = this.peek();
    if (trailing.kind !== "eof") {
      throw new QuerySyntaxError(`Unexpected token '${trailing.value}'`, trailing.position);
    }
    return node;
  }

  private parseOr(): QueryNode {
    const children = [this.parseAnd()];
    while (this.matchKeyword("OR")) children.push(this.parseAnd());
    return booleanNode("or", children);
  }

  private parseAnd(): QueryNode {
    const children = [this.parseUnary()];
    while (true) {
      if (this.matchKeyword("AND")) {
        children.push(this.parseUnary());
        continue;
      }
      if (startsPrimary(this.peek())) {
        children.push(this.parseUnary());
        continue;
      }
      break;
    }
    return booleanNode("and", children);
  }

  private parseUnary(): QueryNode {
    if (this.matchKeyword("NOT")) return notNode(this.parseUnary());
    return this.parsePrimary();
  }

  private parsePrimary(): QueryNode {
    if (this.match("lparen")) {
      const node = this.parseOr();
      if (!this.match("rparen")) {
        const token = this.peek();
        throw new QuerySyntaxError("Expected closing parenthesis", token.position);
      }
      return node;
    }

    const token = this.peek();
    if (token.kind !== "word" && token.kind !== "string") {
      throw new QuerySyntaxError(`Expected a search term, found '${token.value || token.kind}'`, token.position);
    }
    this.cursor += 1;

    if (token.kind === "word" && this.match("colon")) {
      return this.parseCondition(token);
    }
    return textNode(token.value);
  }

  private parseCondition(fieldToken: Token): QueryConditionNode {
    let operator: QueryOperator = "contains";
    if (this.peek().kind === "operator") {
      const comparison = comparisonOperators[this.peek().value];
      if (!comparison) throw new QuerySyntaxError(`Unsupported comparison '${this.peek().value}'`, this.peek().position);
      operator = comparison;
      this.cursor += 1;
    }

    const value = this.peek();
    if (value.kind !== "word" && value.kind !== "string") {
      throw new QuerySyntaxError(`Expected a value for '${fieldToken.value}'`, value.position);
    }
    this.cursor += 1;
    return { type: "condition", field: fieldToken.value, operator, value: value.value };
  }

  private peek(): Token {
    return this.tokens[this.cursor] ?? { kind: "eof", value: "", position: 0 };
  }

  private match(kind: TokenKind): boolean {
    if (this.peek().kind !== kind) return false;
    this.cursor += 1;
    return true;
  }

  private matchKeyword(keyword: string): boolean {
    if (!isKeyword(this.peek(), keyword)) return false;
    this.cursor += 1;
    return true;
  }
}

export function parseQueryText(input: string): QueryNode | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  return new QueryParser(lexQuery(trimmed)).parse();
}
