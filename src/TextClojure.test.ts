import { describe, it } from "node:test";
import assert from "node:assert/strict";
import TextClojure from "./TextClojure.ts";

const metadata = {
    mimetype: "text/x-clojure",
    glyph: "🌿",
    extensions: [".clj", ".cljs", ".cljc", ".edn"] as const,
};

describe("TextClojure — instantiation", () => {
    it("instantiates with metadata", () => {
        const h = new TextClojure(metadata);
        assert.equal(h.mimetype, "text/x-clojure");
        assert.equal(h.glyph, "🌿");
    });
});

describe("TextClojure — extract", () => {
    it("extracts ns as module", () => {
        const h = new TextClojure(metadata);
        const src = "(ns my.app.core)";
        const syms = h.extractRaw(src);
        const ns = syms.find((s) => s.name === "my.app.core");
        assert.ok(ns);
        assert.equal(ns.kind, "module");
    });

    it("extracts def as constant", () => {
        const h = new TextClojure(metadata);
        const src = [
            "(def pi 3.14159)",
            "(def greeting \"hello\")",
        ].join("\n");
        const syms = h.extractRaw(src);
        const pi = syms.find((s) => s.name === "pi");
        assert.ok(pi);
        assert.equal(pi.kind, "constant");
        assert.ok(syms.find((s) => s.name === "greeting" && s.kind === "constant"));
    });

    it("extracts defn as function with params", () => {
        const h = new TextClojure(metadata);
        const src = "(defn add [a b] (+ a b))";
        const syms = h.extractRaw(src);
        const f = syms.find((s) => s.name === "add");
        assert.ok(f);
        assert.equal(f.kind, "function");
        assert.deepEqual(f.params, ["a", "b"]);
    });

    it("extracts defn- (private) as function", () => {
        const h = new TextClojure(metadata);
        const src = "(defn- helper [x] x)";
        const syms = h.extractRaw(src);
        const f = syms.find((s) => s.name === "helper");
        assert.ok(f);
        assert.equal(f.kind, "function");
    });

    it("extracts defmacro as function", () => {
        const h = new TextClojure(metadata);
        const src = "(defmacro when-not [test & body] (list 'if test nil (cons 'do body)))";
        const syms = h.extractRaw(src);
        const m = syms.find((s) => s.name === "when-not");
        assert.ok(m);
        assert.equal(m.kind, "function");
    });

    it("extracts defprotocol as interface + signatures as methods", () => {
        const h = new TextClojure(metadata);
        const src = [
            "(defprotocol Codec",
            "  (encode [this input])",
            "  (decode [this input strict]))",
        ].join("\n");
        const syms = h.extractRaw(src);
        const c = syms.find((s) => s.name === "Codec");
        assert.ok(c);
        assert.equal(c.kind, "interface");
        const enc = syms.find((s) => s.name === "encode");
        assert.ok(enc);
        assert.equal(enc.kind, "method");
        const dec = syms.find((s) => s.name === "decode");
        assert.ok(dec);
    });

    it("extracts defrecord + fields", () => {
        const h = new TextClojure(metadata);
        const src = "(defrecord User [id email name])";
        const syms = h.extractRaw(src);
        const u = syms.find((s) => s.name === "User");
        assert.ok(u);
        assert.equal(u.kind, "class");
        assert.ok(syms.find((s) => s.name === "id" && s.kind === "field"));
        assert.ok(syms.find((s) => s.name === "email"));
        assert.ok(syms.find((s) => s.name === "name"));
    });

    it("extracts deftype + fields", () => {
        const h = new TextClojure(metadata);
        const src = "(deftype Point [x y])";
        const syms = h.extractRaw(src);
        const p = syms.find((s) => s.name === "Point");
        assert.ok(p);
        assert.equal(p.kind, "class");
        assert.ok(syms.find((s) => s.name === "x"));
        assert.ok(syms.find((s) => s.name === "y"));
    });

    it("extracts defmulti / defmethod", () => {
        const h = new TextClojure(metadata);
        const src = [
            "(defmulti area :shape)",
            "(defmethod area :circle [s] (* 3.14 (:r s) (:r s)))",
            "(defmethod area :square [s] (* (:side s) (:side s)))",
        ].join("\n");
        const syms = h.extractRaw(src);
        const m = syms.find((s) => s.name === "area" && s.kind === "function");
        assert.ok(m);
        // defmethod renders as "name dispatch-val"
        assert.ok(syms.find((s) => s.name === "area :circle"));
        assert.ok(syms.find((s) => s.name === "area :square"));
    });

    it("extracts defonce as constant", () => {
        const h = new TextClojure(metadata);
        const src = "(defonce state (atom {}))";
        const syms = h.extractRaw(src);
        const s = syms.find((sym) => sym.name === "state");
        assert.ok(s);
        assert.equal(s.kind, "constant");
    });

    it("returns empty array for empty input", () => {
        const h = new TextClojure(metadata);
        assert.deepEqual(h.extractRaw(""), []);
    });

    it("does not throw on malformed source", () => {
        const h = new TextClojure(metadata);
        assert.doesNotThrow(() => h.extractRaw("(((broken"));
        assert.doesNotThrow(() => h.extractRaw("@@ bogus"));
    });
});

describe("TextClojure — framework integration", () => {
    it("renders extracted hierarchy via format()", () => {
        const h = new TextClojure(metadata);
        const out = h.symbolsRaw("(defn answer [] 42)");
        assert.ok(out.includes("function answer"));
    });

    it("inherits jsonpath query against the symbol outline", async () => {
        const h = new TextClojure(metadata);
        const src = "(defn add [a b] (+ a b))";
        const f = await h.query(src, "jsonpath", "$.add");
        assert.equal(f.length, 1);
    });
});

// Real-world smoke against a representative Clojure namespace.
describe("TextClojure — real-world smoke (ring-handler shape)", () => {
    const SRC = [
        "(ns plurnk.api.handlers",
        "  (:require [ring.util.response :as resp]))",
        "",
        "(def default-page-size 25)",
        "(defonce ^:private cache (atom {}))",
        "",
        "(defprotocol Repo",
        "  (find-by-id [this id])",
        "  (find-all [this]))",
        "",
        "(defrecord InMemoryRepo [data]",
        "  Repo)",
        "",
        "(defn- normalize-id [id]",
        "  (str id))",
        "",
        "(defn list-users [req]",
        "  (resp/response {:users []}))",
        "",
        "(defn get-user [req]",
        "  (resp/response {:user nil}))",
        "",
        "(defmulti handle-event :type)",
        "(defmethod handle-event :user/created [evt] (println evt))",
        "(defmethod handle-event :user/deleted [evt] (println evt))",
    ].join("\n");

    it("surfaces ns, defs, defn(-), defprotocol+methods, defrecord+fields, defmulti+methods", () => {
        const h = new TextClojure(metadata);
        const syms = h.extractRaw(SRC);
        const names = new Set(syms.map((s) => s.name));

        assert.ok(names.has("plurnk.api.handlers"));
        assert.ok(names.has("default-page-size"));
        assert.ok(names.has("cache"));
        assert.ok(names.has("Repo"));
        assert.ok(names.has("find-by-id"));
        assert.ok(names.has("find-all"));
        assert.ok(names.has("InMemoryRepo"));
        assert.ok(names.has("data"));
        assert.ok(names.has("normalize-id"));
        assert.ok(names.has("list-users"));
        assert.ok(names.has("get-user"));
        assert.ok(names.has("handle-event"));
        assert.ok(names.has("handle-event :user/created"));
        assert.ok(names.has("handle-event :user/deleted"));
    });

    it("kind discrimination", () => {
        const h = new TextClojure(metadata);
        const syms = h.extractRaw(SRC);
        const byNameKind = new Map(syms.map((s) => [`${s.name}:${s.kind}`, s]));
        assert.ok(byNameKind.has("plurnk.api.handlers:module"));
        assert.ok(byNameKind.has("default-page-size:constant"));
        assert.ok(byNameKind.has("Repo:interface"));
        assert.ok(byNameKind.has("InMemoryRepo:class"));
        assert.ok(byNameKind.has("list-users:function"));
        assert.ok(byNameKind.has("handle-event:function"));
    });
});
