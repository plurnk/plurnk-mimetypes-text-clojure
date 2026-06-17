import { AntlrExtractor, withExtractor } from "@plurnk/plurnk-mimetypes";
import type { ExtractionVisitor } from "@plurnk/plurnk-mimetypes";
import { CharStream, CommonTokenStream } from "antlr4ng";
import { ClojureLexer } from "./generated/ClojureLexer.ts";
import { ClojureParser } from "./generated/ClojureParser.ts";
import { ClojureVisitor } from "./generated/ClojureVisitor.ts";

// text/x-clojure handler. ANTLR grammar from grammars-v4/clojure.
//
// Parser entry rule: file_ → form* EOF.
//
// In Clojure, everything is an s-expression and "declarations" are macro
// invocations: (def x ...), (defn fn [args] ...), (defmacro ...),
// (defprotocol ...), (defrecord Name ...), (deftype ...), (defmulti ...),
// (defmethod ...), (defonce ...), (ns ns-name ...). We surface each by
// inspecting the first symbol of every top-level list_.
export default class TextClojure extends AntlrExtractor {
    protected parseTree(content: string): unknown {
        const lexer = new ClojureLexer(CharStream.fromString(content));
        const tokens = new CommonTokenStream(lexer);
        const parser = new ClojureParser(tokens);
        parser.removeErrorListeners();
        return parser.file_();
    }

    protected createVisitor(): ExtractionVisitor {
        return new TextClojureVisitor() as unknown as ExtractionVisitor;
    }
}

// SPEC §3 mapping for Clojure:
//   (ns ns-name ...)                → module
//   (def name expr)                 → constant (top-level binding)
//   (defonce name expr)             → constant
//   (defn fn [args] body)           → function
//   (defn- fn [args] body)          → function (private; outline doesn't
//                                     surface visibility)
//   (defmacro m [args] body)        → function
//   (defmulti name dispatch-fn)     → function
//   (defmethod name dispatch body)  → function (rendered as `name dispatch`)
//   (defprotocol P (method ...))    → interface
//   (defrecord R [fields])          → class; fields surface as field syms
//   (deftype T [fields])            → class; fields → field
//   (defstruct s ...)               → class
// References channel (SPEC §16). Clojure is a Lisp: every form is
// `(head arg...)`, so the head symbol of a call form is a function/macro
// invocation → `call`. But special forms and core macros (def, defn, let, if,
// ns, ->, …) are language scaffolding, not meaningful call edges — emitting
// them would be pure noise. We capture call-form heads EXCEPT the curated
// SPECIAL_FORMS skip-set. A `call` whose head name-joins a local `defn`/`def`
// is an edge; external lib calls (`resp/response`) are dead rows, not noise
// (SPEC §16 PRECISION OVER RECALL). Container = the enclosing top-level def/defn
// (gateContainer).
//
// Conservative on host-interop noise: bare `.`/`/`, member access (`.method`),
// and recur targets carry no name-join value and are excluded with the
// special forms. Heads that don't resolve to a symbol (numbers, keywords,
// nested lists in head position) emit nothing.
const SPECIAL_FORMS: ReadonlySet<string> = new Set([
    // definition / binding scaffolding
    "def", "defn", "defn-", "defmacro", "defmulti", "defmethod",
    "defprotocol", "defrecord", "deftype", "defstruct", "defonce",
    "definline", "definterface", "declare", "ns", "in-ns",
    // special forms (clojure.core specials)
    "let", "let*", "fn", "fn*", "if", "if-not", "if-let", "if-some",
    "when", "when-not", "when-let", "when-some", "when-first",
    "do", "quote", "var", "loop", "loop*", "recur", "throw", "try",
    "catch", "finally", "monitor-enter", "monitor-exit", "new", "set!",
    "cond", "condp", "cond->", "cond->>", "case", "and", "or", "not",
    // threading / binding macros
    "->", "->>", "as->", "some->", "some->>", "doto",
    "binding", "with-open", "with-local-vars", "with-redefs",
    "with-bindings", "with-meta", "with-out-str", "dosync",
    // sequence / iteration macros
    "for", "doseq", "dotimes", "while", "doall", "dorun", "lazy-seq",
    // quoting / macro plumbing
    "quasiquote", "unquote", "unquote-splicing", "syntax-quote",
    "comment", "assert", "import", "require", "use", "refer", "load",
]);

class TextClojureVisitor extends withExtractor(ClojureVisitor) {
    visitList_ = (ctx: any): null => {
        // First form's text identifies the macro/special form.
        const forms = collectChildren(ctx, "forms");
        if (forms.length === 0) return null;
        const inner = (forms[0] as { form?: () => Array<unknown> | unknown }).form?.();
        const innerArr = Array.isArray(inner) ? inner : inner ? [inner] : [];
        if (innerArr.length < 1) return null;
        const head = (innerArr[0] as { getText?: () => string }).getText?.();
        if (!head) {
            this.visitChildren(ctx);
            return null;
        }

        // Extract the second form's text as the declared name (where
        // applicable). Some forms (`defmethod`) consume more than two
        // operands before the body — we still emit the name as the second
        // form for simplicity. When a form has a metadata reader macro
        // (`^:private foo`, `^String x`), descend past it to the wrapped
        // symbol.
        const second = unwrapReaderMacro(innerArr[1]);
        const name = (second as { getText?: () => string } | undefined)?.getText?.() ?? null;

        switch (head) {
            case "ns":
                if (name) this.addSymbol("module", name, ctx);
                return null;

            case "def":
            case "defonce":
                if (name) {
                    this.addSymbol("constant", name, ctx);
                    // The initializer expr can contain call forms — scope them
                    // to this binding (SPEC §16 container = enclosing def).
                    this.gateContainer(name, ctx);
                }
                return null;

            case "defn":
            case "defn-":
            case "defmacro":
            case "defmulti":
                if (name) {
                    const params = extractParamVector(innerArr);
                    this.addSymbol("function", name, ctx, params);
                    // Body call forms are `call` refs scoped to this function.
                    this.gateContainer(name, ctx);
                }
                return null;

            case "defmethod": {
                // (defmethod name dispatch-val [args] body)
                const dispatch = innerArr[2];
                const dispatchText = (dispatch as { getText?: () => string } | undefined)?.getText?.();
                if (name) {
                    const display = dispatchText ? `${name} ${dispatchText}` : name;
                    this.addSymbol("function", display, ctx);
                    this.gateContainer(display, ctx);
                }
                return null;
            }

            case "defprotocol":
                if (name) {
                    this.addSymbol("interface", name, ctx);
                    // Each subsequent list_ inside the body is a method signature:
                    //   (method-name [args] "doc")
                    for (let i = 2; i < innerArr.length; i += 1) {
                        const sigName = firstSymbolInListForm(innerArr[i]);
                        if (sigName) this.addSymbol("method", sigName, ctx);
                    }
                }
                return null;

            case "defrecord":
            case "deftype":
            case "defstruct":
                if (name) {
                    this.addSymbol("class", name, ctx);
                    // The next form is typically the field vector.
                    const fields = extractFieldVector(innerArr[2]);
                    for (const f of fields) this.addSymbol("field", f, ctx);
                }
                return null;

            default:
                // Any other list is an expression. Classify its head as a
                // `call` ref (unless special-form / host-interop noise), then
                // recurse so nested call forms are reached too.
                this.emitCallHead(innerArr[0], head);
                this.visitChildren(ctx);
                return null;
        }
    };

    // Classify the head of a call form `(head arg...)` as a `call` ref unless
    // it is a special form / core macro (SPECIAL_FORMS) or a host-interop /
    // non-symbol head with no name-join value. Position comes from the head's
    // symbol context (the callee name node, SPEC §16).
    emitCallHead(headForm: unknown, head: string): void {
        if (SPECIAL_FORMS.has(head)) return;
        // Host interop with no local name-join: bare punctuation symbols and
        // member access (`.method`).
        if (head === "." || head === "/" || head.startsWith(".")) return;
        const sym = headSymbolCtx(headForm);
        if (!sym) return; // head is a number/keyword/string/vector/nested list
        this.addRef("call", head, sym as never);
    }
}

// A head form resolves to a symbol when it is `literal → symbol →
// (simple_sym | ns_symbol)`. Returns the innermost symbol context (for
// position) or null when the head isn't a symbol.
function headSymbolCtx(form: unknown): unknown {
    const lit = (form as { literal?: () => unknown } | undefined)?.literal?.();
    if (!lit) return null;
    const sym = (lit as { symbol?: () => unknown }).symbol?.();
    if (!sym) return null;
    const s = sym as { simple_sym?: () => unknown; ns_symbol?: () => unknown };
    return s.simple_sym?.() ?? s.ns_symbol?.() ?? null;
}

// Find the first vector in the forms after the (defn/defmulti/etc) name
// and return its contained symbol texts.
function extractParamVector(formArr: unknown[]): string[] {
    for (let i = 2; i < formArr.length; i += 1) {
        const f = formArr[i] as { vector?: () => unknown };
        const vec = f.vector?.();
        if (vec) return vectorSymbolNames(vec);
    }
    return [];
}

function extractFieldVector(form: unknown): string[] {
    if (!form) return [];
    const f = form as { vector?: () => unknown };
    const vec = f.vector?.();
    if (!vec) return [];
    return vectorSymbolNames(vec);
}

function vectorSymbolNames(vec: unknown): string[] {
    const node = vec as { forms?: () => unknown };
    const forms = node.forms?.();
    if (!forms) return [];
    const fNode = forms as { form?: () => Array<unknown> | unknown };
    const raw = fNode.form?.();
    const arr = Array.isArray(raw) ? raw : raw ? [raw] : [];
    const out: string[] = [];
    for (const f of arr) {
        const t = (f as { getText?: () => string }).getText?.();
        if (t && !t.startsWith("&")) out.push(t);
    }
    return out;
}

// For (defprotocol P (method-name [args] "doc") (other-method ...) ...),
// each child of innerArr after the protocol name is itself a list. Pull the
// first symbol inside each.
function firstSymbolInListForm(form: unknown): string | null {
    const f = form as { list_?: () => unknown };
    const list = f.list_?.();
    if (!list) return null;
    const formsCtx = collectChildren(list, "forms")[0];
    if (!formsCtx) return null;
    const inner = (formsCtx as { form?: () => Array<unknown> | unknown }).form?.();
    const arr = Array.isArray(inner) ? inner : inner ? [inner] : [];
    if (arr.length === 0) return null;
    return (arr[0] as { getText?: () => string }).getText?.() ?? null;
}

// A reader_macro like `^:private foo` wraps the actual form. The grammar's
// metadata production has shape `^ form form` — the LAST form is the value
// being annotated. Descend recursively (annotations can stack).
function unwrapReaderMacro(form: unknown): unknown {
    if (!form) return form;
    const f = form as { reader_macro?: () => unknown };
    const rm = f.reader_macro?.();
    if (!rm) return form;
    // tag: '^' form form     — type/metadata annotation: second form is target
    // meta_data: '#^' form form — alternative meta syntax: same shape
    const rmNode = rm as {
        tag?: () => unknown;
        meta_data?: () => unknown;
    };
    const tag = rmNode.tag?.() ?? rmNode.meta_data?.();
    if (!tag) return form;
    const tagForms = collectChildren(tag, "form");
    if (tagForms.length >= 2) return unwrapReaderMacro(tagForms[tagForms.length - 1]);
    return form;
}

function collectChildren(ctx: unknown, methodName: string): unknown[] {
    const node = ctx as Record<string, unknown>;
    const accessor = node[methodName] as ((...args: unknown[]) => unknown) | undefined;
    if (typeof accessor !== "function") return [];
    const raw = accessor.call(node);
    if (Array.isArray(raw)) return raw;
    return raw ? [raw] : [];
}
