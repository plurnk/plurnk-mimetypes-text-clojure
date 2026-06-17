import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { assertHandlerConformance } from "@plurnk/plurnk-mimetypes/conformance";
import TextClojure from "./TextClojure.ts";

const metadata = {
    mimetype: "text/x-clojure",
    glyph: "🌿",
    extensions: [".clj", ".cljs", ".cljc", ".edn"] as const,
};
const h = () => new TextClojure(metadata);

// decoyNames (frobnicate / TODO / secret) live only in a string + comment and
// must NOT surface as refs. `process` and `normalize` are local defns the call
// graph joins on; `str` / `map` / `reduce` / `filter` / `resp/response` are
// external — dead rows, not noise (SPEC §16 PRECISION OVER RECALL).
const SRC = `(ns demo.core
  (:require [ring.util.response :as resp]))

(def banner "frobnicate the widget")

(defn- normalize [id]
  ;; TODO secret handling
  (str id))

(defn process [xs]
  (let [ys (map inc xs)]
    (reduce + 0 (filter even? ys))))

(defn handler [req]
  (resp/response (process (normalize (:id req)))))

(def total (reduce + (process [1 2 3])))
`;

describe("TextClojure — references (call graph)", () => {
    it("captures call-form heads as `call` refs scoped to the enclosing def", () => {
        const refs = h().references(SRC);
        assert.ok(refs.some((r) => r.name === "str" && r.kind === "call" && r.container === "normalize"));
        assert.ok(refs.some((r) => r.name === "map" && r.kind === "call" && r.container === "process"));
        assert.ok(refs.some((r) => r.name === "process" && r.kind === "call" && r.container === "handler"));
        assert.ok(refs.some((r) => r.name === "normalize" && r.kind === "call" && r.container === "handler"));
    });

    it("local-defn calls join; external lib calls are dead rows (still emitted)", () => {
        const refs = h().references(SRC);
        // process is a local defn — the call from handler/total resolves to it.
        assert.equal(refs.filter((r) => r.name === "process").length, 2);
        // resp/response is external (ring) — emitted, name-joins nothing.
        assert.ok(refs.some((r) => r.name === "resp/response" && r.kind === "call"));
    });

    it("special forms and core macros are NOT refs (skip-set)", () => {
        const refs = h().references(SRC);
        for (const sf of ["ns", "def", "defn", "defn-", "let", "require"]) {
            assert.ok(!refs.some((r) => r.name === sf), `${sf} must not surface as a call ref`);
        }
    });

    it("call ARGS (bare identifier reads) are not refs — only heads", () => {
        const refs = h().references(SRC);
        // inc / even? / + appear only as arguments, never as a call head here.
        for (const arg of ["inc", "even?", "+"]) {
            assert.ok(!refs.some((r) => r.name === arg), `${arg} is an arg, not a call head`);
        }
    });

    it("no ref inside the string literal or comment", () => {
        const refs = h().references(SRC);
        assert.ok(!refs.some((r) => r.name === "frobnicate" || r.name === "widget"));
        assert.ok(!refs.some((r) => r.name === "TODO" || r.name === "secret"));
    });

    it("passes the SPEC §16 conformance invariants", async () => {
        await assertHandlerConformance(h(), {
            source: SRC,
            decoyNames: ["frobnicate", "widget", "TODO", "secret"],
            expectJoins: [
                { refName: "process", container: "handler" },
                { refName: "normalize", container: "handler" },
                { refName: "process", container: "total" },
            ],
            expectRefs: [
                { name: "process", kind: "call" },
                { name: "normalize", kind: "call" },
                { name: "reduce", kind: "call" },
            ],
        });
    });
});
