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
class TextClojureVisitor extends withExtractor(ClojureVisitor) {
    visitList_ = (ctx: any): null => {
        if (this.inBody) return null;
        // First form's text identifies the macro/special form.
        const forms = collectChildren(ctx, "forms");
        if (forms.length === 0) return null;
        const inner = (forms[0] as { form?: () => Array<unknown> | unknown }).form?.();
        const innerArr = Array.isArray(inner) ? inner : inner ? [inner] : [];
        if (innerArr.length < 1) return null;
        const head = (innerArr[0] as { getText?: () => string }).getText?.();
        if (!head) return null;

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
                if (name) this.addSymbol("constant", name, ctx);
                return null;

            case "defn":
            case "defn-":
            case "defmacro":
            case "defmulti":
                if (name) {
                    const params = extractParamVector(innerArr);
                    this.addSymbol("function", name, ctx, params);
                }
                return null;

            case "defmethod": {
                // (defmethod name dispatch-val [args] body)
                const dispatch = innerArr[2];
                const dispatchText = (dispatch as { getText?: () => string } | undefined)?.getText?.();
                if (name) {
                    const display = dispatchText ? `${name} ${dispatchText}` : name;
                    this.addSymbol("function", display, ctx);
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
                return null;
        }
    };
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
