#!/usr/bin/env node
import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __require = /* @__PURE__ */ ((x) => typeof require !== "undefined" ? require : typeof Proxy !== "undefined" ? new Proxy(x, {
  get: (a, b) => (typeof require !== "undefined" ? require : a)[b]
}) : x)(function(x) {
  if (typeof require !== "undefined") return require.apply(this, arguments);
  throw Error('Dynamic require of "' + x + '" is not supported');
});
var __commonJS = (cb, mod) => function __require2() {
  try {
    return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
  } catch (e) {
    throw mod = 0, e;
  }
};
var __export = (target, all2) => {
  for (var name in all2)
    __defProp(target, name, { get: all2[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// node_modules/yaml/dist/nodes/identity.js
var require_identity = __commonJS({
  "node_modules/yaml/dist/nodes/identity.js"(exports) {
    "use strict";
    var ALIAS = /* @__PURE__ */ Symbol.for("yaml.alias");
    var DOC = /* @__PURE__ */ Symbol.for("yaml.document");
    var MAP = /* @__PURE__ */ Symbol.for("yaml.map");
    var PAIR = /* @__PURE__ */ Symbol.for("yaml.pair");
    var SCALAR = /* @__PURE__ */ Symbol.for("yaml.scalar");
    var SEQ = /* @__PURE__ */ Symbol.for("yaml.seq");
    var NODE_TYPE = /* @__PURE__ */ Symbol.for("yaml.node.type");
    var isAlias = (node2) => !!node2 && typeof node2 === "object" && node2[NODE_TYPE] === ALIAS;
    var isDocument = (node2) => !!node2 && typeof node2 === "object" && node2[NODE_TYPE] === DOC;
    var isMap3 = (node2) => !!node2 && typeof node2 === "object" && node2[NODE_TYPE] === MAP;
    var isPair = (node2) => !!node2 && typeof node2 === "object" && node2[NODE_TYPE] === PAIR;
    var isScalar = (node2) => !!node2 && typeof node2 === "object" && node2[NODE_TYPE] === SCALAR;
    var isSeq2 = (node2) => !!node2 && typeof node2 === "object" && node2[NODE_TYPE] === SEQ;
    function isCollection(node2) {
      if (node2 && typeof node2 === "object")
        switch (node2[NODE_TYPE]) {
          case MAP:
          case SEQ:
            return true;
        }
      return false;
    }
    function isNode(node2) {
      if (node2 && typeof node2 === "object")
        switch (node2[NODE_TYPE]) {
          case ALIAS:
          case MAP:
          case SCALAR:
          case SEQ:
            return true;
        }
      return false;
    }
    var hasAnchor = (node2) => (isScalar(node2) || isCollection(node2)) && !!node2.anchor;
    exports.ALIAS = ALIAS;
    exports.DOC = DOC;
    exports.MAP = MAP;
    exports.NODE_TYPE = NODE_TYPE;
    exports.PAIR = PAIR;
    exports.SCALAR = SCALAR;
    exports.SEQ = SEQ;
    exports.hasAnchor = hasAnchor;
    exports.isAlias = isAlias;
    exports.isCollection = isCollection;
    exports.isDocument = isDocument;
    exports.isMap = isMap3;
    exports.isNode = isNode;
    exports.isPair = isPair;
    exports.isScalar = isScalar;
    exports.isSeq = isSeq2;
  }
});

// node_modules/yaml/dist/visit.js
var require_visit = __commonJS({
  "node_modules/yaml/dist/visit.js"(exports) {
    "use strict";
    var identity = require_identity();
    var BREAK = /* @__PURE__ */ Symbol("break visit");
    var SKIP2 = /* @__PURE__ */ Symbol("skip children");
    var REMOVE = /* @__PURE__ */ Symbol("remove node");
    function visit2(node2, visitor) {
      const visitor_ = initVisitor(visitor);
      if (identity.isDocument(node2)) {
        const cd = visit_(null, node2.contents, visitor_, Object.freeze([node2]));
        if (cd === REMOVE)
          node2.contents = null;
      } else
        visit_(null, node2, visitor_, Object.freeze([]));
    }
    visit2.BREAK = BREAK;
    visit2.SKIP = SKIP2;
    visit2.REMOVE = REMOVE;
    function visit_(key, node2, visitor, path2) {
      const ctrl = callVisitor(key, node2, visitor, path2);
      if (identity.isNode(ctrl) || identity.isPair(ctrl)) {
        replaceNode(key, path2, ctrl);
        return visit_(key, ctrl, visitor, path2);
      }
      if (typeof ctrl !== "symbol") {
        if (identity.isCollection(node2)) {
          path2 = Object.freeze(path2.concat(node2));
          for (let i = 0; i < node2.items.length; ++i) {
            const ci = visit_(i, node2.items[i], visitor, path2);
            if (typeof ci === "number")
              i = ci - 1;
            else if (ci === BREAK)
              return BREAK;
            else if (ci === REMOVE) {
              node2.items.splice(i, 1);
              i -= 1;
            }
          }
        } else if (identity.isPair(node2)) {
          path2 = Object.freeze(path2.concat(node2));
          const ck = visit_("key", node2.key, visitor, path2);
          if (ck === BREAK)
            return BREAK;
          else if (ck === REMOVE)
            node2.key = null;
          const cv = visit_("value", node2.value, visitor, path2);
          if (cv === BREAK)
            return BREAK;
          else if (cv === REMOVE)
            node2.value = null;
        }
      }
      return ctrl;
    }
    async function visitAsync(node2, visitor) {
      const visitor_ = initVisitor(visitor);
      if (identity.isDocument(node2)) {
        const cd = await visitAsync_(null, node2.contents, visitor_, Object.freeze([node2]));
        if (cd === REMOVE)
          node2.contents = null;
      } else
        await visitAsync_(null, node2, visitor_, Object.freeze([]));
    }
    visitAsync.BREAK = BREAK;
    visitAsync.SKIP = SKIP2;
    visitAsync.REMOVE = REMOVE;
    async function visitAsync_(key, node2, visitor, path2) {
      const ctrl = await callVisitor(key, node2, visitor, path2);
      if (identity.isNode(ctrl) || identity.isPair(ctrl)) {
        replaceNode(key, path2, ctrl);
        return visitAsync_(key, ctrl, visitor, path2);
      }
      if (typeof ctrl !== "symbol") {
        if (identity.isCollection(node2)) {
          path2 = Object.freeze(path2.concat(node2));
          for (let i = 0; i < node2.items.length; ++i) {
            const ci = await visitAsync_(i, node2.items[i], visitor, path2);
            if (typeof ci === "number")
              i = ci - 1;
            else if (ci === BREAK)
              return BREAK;
            else if (ci === REMOVE) {
              node2.items.splice(i, 1);
              i -= 1;
            }
          }
        } else if (identity.isPair(node2)) {
          path2 = Object.freeze(path2.concat(node2));
          const ck = await visitAsync_("key", node2.key, visitor, path2);
          if (ck === BREAK)
            return BREAK;
          else if (ck === REMOVE)
            node2.key = null;
          const cv = await visitAsync_("value", node2.value, visitor, path2);
          if (cv === BREAK)
            return BREAK;
          else if (cv === REMOVE)
            node2.value = null;
        }
      }
      return ctrl;
    }
    function initVisitor(visitor) {
      if (typeof visitor === "object" && (visitor.Collection || visitor.Node || visitor.Value)) {
        return Object.assign({
          Alias: visitor.Node,
          Map: visitor.Node,
          Scalar: visitor.Node,
          Seq: visitor.Node
        }, visitor.Value && {
          Map: visitor.Value,
          Scalar: visitor.Value,
          Seq: visitor.Value
        }, visitor.Collection && {
          Map: visitor.Collection,
          Seq: visitor.Collection
        }, visitor);
      }
      return visitor;
    }
    function callVisitor(key, node2, visitor, path2) {
      if (typeof visitor === "function")
        return visitor(key, node2, path2);
      if (identity.isMap(node2))
        return visitor.Map?.(key, node2, path2);
      if (identity.isSeq(node2))
        return visitor.Seq?.(key, node2, path2);
      if (identity.isPair(node2))
        return visitor.Pair?.(key, node2, path2);
      if (identity.isScalar(node2))
        return visitor.Scalar?.(key, node2, path2);
      if (identity.isAlias(node2))
        return visitor.Alias?.(key, node2, path2);
      return void 0;
    }
    function replaceNode(key, path2, node2) {
      const parent = path2[path2.length - 1];
      if (identity.isCollection(parent)) {
        parent.items[key] = node2;
      } else if (identity.isPair(parent)) {
        if (key === "key")
          parent.key = node2;
        else
          parent.value = node2;
      } else if (identity.isDocument(parent)) {
        parent.contents = node2;
      } else {
        const pt = identity.isAlias(parent) ? "alias" : "scalar";
        throw new Error(`Cannot replace node with ${pt} parent`);
      }
    }
    exports.visit = visit2;
    exports.visitAsync = visitAsync;
  }
});

// node_modules/yaml/dist/doc/directives.js
var require_directives = __commonJS({
  "node_modules/yaml/dist/doc/directives.js"(exports) {
    "use strict";
    var identity = require_identity();
    var visit2 = require_visit();
    var escapeChars = {
      "!": "%21",
      ",": "%2C",
      "[": "%5B",
      "]": "%5D",
      "{": "%7B",
      "}": "%7D"
    };
    var escapeTagName = (tn) => tn.replace(/[!,[\]{}]/g, (ch) => escapeChars[ch]);
    var Directives = class _Directives {
      constructor(yaml, tags) {
        this.docStart = null;
        this.docEnd = false;
        this.yaml = Object.assign({}, _Directives.defaultYaml, yaml);
        this.tags = Object.assign({}, _Directives.defaultTags, tags);
      }
      clone() {
        const copy = new _Directives(this.yaml, this.tags);
        copy.docStart = this.docStart;
        return copy;
      }
      /**
       * During parsing, get a Directives instance for the current document and
       * update the stream state according to the current version's spec.
       */
      atDocument() {
        const res = new _Directives(this.yaml, this.tags);
        switch (this.yaml.version) {
          case "1.1":
            this.atNextDocument = true;
            break;
          case "1.2":
            this.atNextDocument = false;
            this.yaml = {
              explicit: _Directives.defaultYaml.explicit,
              version: "1.2"
            };
            this.tags = Object.assign({}, _Directives.defaultTags);
            break;
        }
        return res;
      }
      /**
       * @param onError - May be called even if the action was successful
       * @returns `true` on success
       */
      add(line2, onError) {
        if (this.atNextDocument) {
          this.yaml = { explicit: _Directives.defaultYaml.explicit, version: "1.1" };
          this.tags = Object.assign({}, _Directives.defaultTags);
          this.atNextDocument = false;
        }
        const parts = line2.trim().split(/[ \t]+/);
        const name = parts.shift();
        switch (name) {
          case "%TAG": {
            if (parts.length !== 2) {
              onError(0, "%TAG directive should contain exactly two parts");
              if (parts.length < 2)
                return false;
            }
            const [handle, prefix] = parts;
            this.tags[handle] = prefix;
            return true;
          }
          case "%YAML": {
            this.yaml.explicit = true;
            if (parts.length !== 1) {
              onError(0, "%YAML directive should contain exactly one part");
              return false;
            }
            const [version] = parts;
            if (version === "1.1" || version === "1.2") {
              this.yaml.version = version;
              return true;
            } else {
              const isValid = /^\d+\.\d+$/.test(version);
              onError(6, `Unsupported YAML version ${version}`, isValid);
              return false;
            }
          }
          default:
            onError(0, `Unknown directive ${name}`, true);
            return false;
        }
      }
      /**
       * Resolves a tag, matching handles to those defined in %TAG directives.
       *
       * @returns Resolved tag, which may also be the non-specific tag `'!'` or a
       *   `'!local'` tag, or `null` if unresolvable.
       */
      tagName(source, onError) {
        if (source === "!")
          return "!";
        if (source[0] !== "!") {
          onError(`Not a valid tag: ${source}`);
          return null;
        }
        if (source[1] === "<") {
          const verbatim = source.slice(2, -1);
          if (verbatim === "!" || verbatim === "!!") {
            onError(`Verbatim tags aren't resolved, so ${source} is invalid.`);
            return null;
          }
          if (source[source.length - 1] !== ">")
            onError("Verbatim tags must end with a >");
          return verbatim;
        }
        const [, handle, suffix] = source.match(/^(.*!)([^!]*)$/s);
        if (!suffix)
          onError(`The ${source} tag has no suffix`);
        const prefix = this.tags[handle];
        if (prefix) {
          try {
            return prefix + decodeURIComponent(suffix);
          } catch (error) {
            onError(String(error));
            return null;
          }
        }
        if (handle === "!")
          return source;
        onError(`Could not resolve tag: ${source}`);
        return null;
      }
      /**
       * Given a fully resolved tag, returns its printable string form,
       * taking into account current tag prefixes and defaults.
       */
      tagString(tag) {
        for (const [handle, prefix] of Object.entries(this.tags)) {
          if (tag.startsWith(prefix))
            return handle + escapeTagName(tag.substring(prefix.length));
        }
        return tag[0] === "!" ? tag : `!<${tag}>`;
      }
      toString(doc) {
        const lines2 = this.yaml.explicit ? [`%YAML ${this.yaml.version || "1.2"}`] : [];
        const tagEntries = Object.entries(this.tags);
        let tagNames;
        if (doc && tagEntries.length > 0 && identity.isNode(doc.contents)) {
          const tags = {};
          visit2.visit(doc.contents, (_key, node2) => {
            if (identity.isNode(node2) && node2.tag)
              tags[node2.tag] = true;
          });
          tagNames = Object.keys(tags);
        } else
          tagNames = [];
        for (const [handle, prefix] of tagEntries) {
          if (handle === "!!" && prefix === "tag:yaml.org,2002:")
            continue;
          if (!doc || tagNames.some((tn) => tn.startsWith(prefix)))
            lines2.push(`%TAG ${handle} ${prefix}`);
        }
        return lines2.join("\n");
      }
    };
    Directives.defaultYaml = { explicit: false, version: "1.2" };
    Directives.defaultTags = { "!!": "tag:yaml.org,2002:" };
    exports.Directives = Directives;
  }
});

// node_modules/yaml/dist/doc/anchors.js
var require_anchors = __commonJS({
  "node_modules/yaml/dist/doc/anchors.js"(exports) {
    "use strict";
    var identity = require_identity();
    var visit2 = require_visit();
    function anchorIsValid(anchor) {
      if (/[\x00-\x19\s,[\]{}]/.test(anchor)) {
        const sa = JSON.stringify(anchor);
        const msg = `Anchor must not contain whitespace or control characters: ${sa}`;
        throw new Error(msg);
      }
      return true;
    }
    function anchorNames(root) {
      const anchors = /* @__PURE__ */ new Set();
      visit2.visit(root, {
        Value(_key, node2) {
          if (node2.anchor)
            anchors.add(node2.anchor);
        }
      });
      return anchors;
    }
    function findNewAnchor(prefix, exclude) {
      for (let i = 1; true; ++i) {
        const name = `${prefix}${i}`;
        if (!exclude.has(name))
          return name;
      }
    }
    function createNodeAnchors(doc, prefix) {
      const aliasObjects = [];
      const sourceObjects = /* @__PURE__ */ new Map();
      let prevAnchors = null;
      return {
        onAnchor: (source) => {
          aliasObjects.push(source);
          prevAnchors ?? (prevAnchors = anchorNames(doc));
          const anchor = findNewAnchor(prefix, prevAnchors);
          prevAnchors.add(anchor);
          return anchor;
        },
        /**
         * With circular references, the source node is only resolved after all
         * of its child nodes are. This is why anchors are set only after all of
         * the nodes have been created.
         */
        setAnchors: () => {
          for (const source of aliasObjects) {
            const ref = sourceObjects.get(source);
            if (typeof ref === "object" && ref.anchor && (identity.isScalar(ref.node) || identity.isCollection(ref.node))) {
              ref.node.anchor = ref.anchor;
            } else {
              const error = new Error("Failed to resolve repeated object (this should not happen)");
              error.source = source;
              throw error;
            }
          }
        },
        sourceObjects
      };
    }
    exports.anchorIsValid = anchorIsValid;
    exports.anchorNames = anchorNames;
    exports.createNodeAnchors = createNodeAnchors;
    exports.findNewAnchor = findNewAnchor;
  }
});

// node_modules/yaml/dist/doc/applyReviver.js
var require_applyReviver = __commonJS({
  "node_modules/yaml/dist/doc/applyReviver.js"(exports) {
    "use strict";
    function applyReviver(reviver, obj, key, val) {
      if (val && typeof val === "object") {
        if (Array.isArray(val)) {
          for (let i = 0, len = val.length; i < len; ++i) {
            const v0 = val[i];
            const v1 = applyReviver(reviver, val, String(i), v0);
            if (v1 === void 0)
              delete val[i];
            else if (v1 !== v0)
              val[i] = v1;
          }
        } else if (val instanceof Map) {
          for (const k of Array.from(val.keys())) {
            const v0 = val.get(k);
            const v1 = applyReviver(reviver, val, k, v0);
            if (v1 === void 0)
              val.delete(k);
            else if (v1 !== v0)
              val.set(k, v1);
          }
        } else if (val instanceof Set) {
          for (const v0 of Array.from(val)) {
            const v1 = applyReviver(reviver, val, v0, v0);
            if (v1 === void 0)
              val.delete(v0);
            else if (v1 !== v0) {
              val.delete(v0);
              val.add(v1);
            }
          }
        } else {
          for (const [k, v0] of Object.entries(val)) {
            const v1 = applyReviver(reviver, val, k, v0);
            if (v1 === void 0)
              delete val[k];
            else if (v1 !== v0)
              val[k] = v1;
          }
        }
      }
      return reviver.call(obj, key, val);
    }
    exports.applyReviver = applyReviver;
  }
});

// node_modules/yaml/dist/nodes/toJS.js
var require_toJS = __commonJS({
  "node_modules/yaml/dist/nodes/toJS.js"(exports) {
    "use strict";
    var identity = require_identity();
    function toJS(value, arg, ctx) {
      if (Array.isArray(value))
        return value.map((v, i) => toJS(v, String(i), ctx));
      if (value && typeof value.toJSON === "function") {
        if (!ctx || !identity.hasAnchor(value))
          return value.toJSON(arg, ctx);
        const data = { aliasCount: 0, count: 1, res: void 0 };
        ctx.anchors.set(value, data);
        ctx.onCreate = (res2) => {
          data.res = res2;
          delete ctx.onCreate;
        };
        const res = value.toJSON(arg, ctx);
        if (ctx.onCreate)
          ctx.onCreate(res);
        return res;
      }
      if (typeof value === "bigint" && !ctx?.keep)
        return Number(value);
      return value;
    }
    exports.toJS = toJS;
  }
});

// node_modules/yaml/dist/nodes/Node.js
var require_Node = __commonJS({
  "node_modules/yaml/dist/nodes/Node.js"(exports) {
    "use strict";
    var applyReviver = require_applyReviver();
    var identity = require_identity();
    var toJS = require_toJS();
    var NodeBase = class {
      constructor(type) {
        Object.defineProperty(this, identity.NODE_TYPE, { value: type });
      }
      /** Create a copy of this node.  */
      clone() {
        const copy = Object.create(Object.getPrototypeOf(this), Object.getOwnPropertyDescriptors(this));
        if (this.range)
          copy.range = this.range.slice();
        return copy;
      }
      /** A plain JavaScript representation of this node. */
      toJS(doc, { mapAsMap, maxAliasCount, onAnchor, reviver } = {}) {
        if (!identity.isDocument(doc))
          throw new TypeError("A document argument is required");
        const ctx = {
          anchors: /* @__PURE__ */ new Map(),
          doc,
          keep: true,
          mapAsMap: mapAsMap === true,
          mapKeyWarned: false,
          maxAliasCount: typeof maxAliasCount === "number" ? maxAliasCount : 100
        };
        const res = toJS.toJS(this, "", ctx);
        if (typeof onAnchor === "function")
          for (const { count: count4, res: res2 } of ctx.anchors.values())
            onAnchor(res2, count4);
        return typeof reviver === "function" ? applyReviver.applyReviver(reviver, { "": res }, "", res) : res;
      }
    };
    exports.NodeBase = NodeBase;
  }
});

// node_modules/yaml/dist/nodes/Alias.js
var require_Alias = __commonJS({
  "node_modules/yaml/dist/nodes/Alias.js"(exports) {
    "use strict";
    var anchors = require_anchors();
    var visit2 = require_visit();
    var identity = require_identity();
    var Node = require_Node();
    var toJS = require_toJS();
    var Alias = class extends Node.NodeBase {
      constructor(source) {
        super(identity.ALIAS);
        this.source = source;
        Object.defineProperty(this, "tag", {
          set() {
            throw new Error("Alias nodes cannot have tags");
          }
        });
      }
      /**
       * Resolve the value of this alias within `doc`, finding the last
       * instance of the `source` anchor before this node.
       */
      resolve(doc, ctx) {
        if (ctx?.maxAliasCount === 0)
          throw new ReferenceError("Alias resolution is disabled");
        let nodes;
        if (ctx?.aliasResolveCache) {
          nodes = ctx.aliasResolveCache;
        } else {
          nodes = [];
          visit2.visit(doc, {
            Node: (_key, node2) => {
              if (identity.isAlias(node2) || identity.hasAnchor(node2))
                nodes.push(node2);
            }
          });
          if (ctx)
            ctx.aliasResolveCache = nodes;
        }
        let found = void 0;
        for (const node2 of nodes) {
          if (node2 === this)
            break;
          if (node2.anchor === this.source)
            found = node2;
        }
        if (found && ctx) {
          const { anchors: anchors2, doc: doc2, maxAliasCount } = ctx;
          let data = anchors2.get(found);
          if (!data) {
            toJS.toJS(found, null, ctx);
            data = anchors2.get(found);
          }
          if (data?.res === void 0) {
            const msg = "This should not happen: Alias anchor was not resolved?";
            throw new ReferenceError(msg);
          }
          if (maxAliasCount >= 0) {
            data.count += 1;
            if (data.aliasCount === 0)
              data.aliasCount = getAliasCount(doc2, found, anchors2);
            if (data.count * data.aliasCount > maxAliasCount) {
              const msg = "Excessive alias count indicates a resource exhaustion attack";
              throw new ReferenceError(msg);
            }
          }
        }
        return found;
      }
      toJSON(_arg, ctx) {
        if (!ctx)
          return { source: this.source };
        const source = this.resolve(ctx.doc, ctx);
        if (!source) {
          const msg = `Unresolved alias (the anchor must be set before the alias): ${this.source}`;
          throw new ReferenceError(msg);
        }
        return ctx.anchors.get(source).res;
      }
      toString(ctx, _onComment, _onChompKeep) {
        const src = `*${this.source}`;
        if (ctx) {
          anchors.anchorIsValid(this.source);
          if (ctx.options.verifyAliasOrder && !ctx.anchors.has(this.source)) {
            const msg = `Unresolved alias (the anchor must be set before the alias): ${this.source}`;
            throw new Error(msg);
          }
          if (ctx.implicitKey)
            return `${src} `;
        }
        return src;
      }
    };
    function getAliasCount(doc, node2, anchors2) {
      if (identity.isAlias(node2)) {
        const source = node2.resolve(doc);
        const anchor = anchors2 && source && anchors2.get(source);
        return anchor ? anchor.count * anchor.aliasCount : 0;
      } else if (identity.isCollection(node2)) {
        let count4 = 0;
        for (const item of node2.items) {
          const c = getAliasCount(doc, item, anchors2);
          if (c > count4)
            count4 = c;
        }
        return count4;
      } else if (identity.isPair(node2)) {
        const kc = getAliasCount(doc, node2.key, anchors2);
        const vc = getAliasCount(doc, node2.value, anchors2);
        return Math.max(kc, vc);
      }
      return 1;
    }
    exports.Alias = Alias;
  }
});

// node_modules/yaml/dist/nodes/Scalar.js
var require_Scalar = __commonJS({
  "node_modules/yaml/dist/nodes/Scalar.js"(exports) {
    "use strict";
    var identity = require_identity();
    var Node = require_Node();
    var toJS = require_toJS();
    var isScalarValue = (value) => !value || typeof value !== "function" && typeof value !== "object";
    var Scalar = class extends Node.NodeBase {
      constructor(value) {
        super(identity.SCALAR);
        this.value = value;
      }
      toJSON(arg, ctx) {
        return ctx?.keep ? this.value : toJS.toJS(this.value, arg, ctx);
      }
      toString() {
        return String(this.value);
      }
    };
    Scalar.BLOCK_FOLDED = "BLOCK_FOLDED";
    Scalar.BLOCK_LITERAL = "BLOCK_LITERAL";
    Scalar.PLAIN = "PLAIN";
    Scalar.QUOTE_DOUBLE = "QUOTE_DOUBLE";
    Scalar.QUOTE_SINGLE = "QUOTE_SINGLE";
    exports.Scalar = Scalar;
    exports.isScalarValue = isScalarValue;
  }
});

// node_modules/yaml/dist/doc/createNode.js
var require_createNode = __commonJS({
  "node_modules/yaml/dist/doc/createNode.js"(exports) {
    "use strict";
    var Alias = require_Alias();
    var identity = require_identity();
    var Scalar = require_Scalar();
    var defaultTagPrefix = "tag:yaml.org,2002:";
    function findTagObject(value, tagName, tags) {
      if (tagName) {
        const match = tags.filter((t) => t.tag === tagName);
        const tagObj = match.find((t) => !t.format) ?? match[0];
        if (!tagObj)
          throw new Error(`Tag ${tagName} not found`);
        return tagObj;
      }
      return tags.find((t) => t.identify?.(value) && !t.format);
    }
    function createNode(value, tagName, ctx) {
      if (identity.isDocument(value))
        value = value.contents;
      if (identity.isNode(value))
        return value;
      if (identity.isPair(value)) {
        const map = ctx.schema[identity.MAP].createNode?.(ctx.schema, null, ctx);
        map.items.push(value);
        return map;
      }
      if (value instanceof String || value instanceof Number || value instanceof Boolean || typeof BigInt !== "undefined" && value instanceof BigInt) {
        value = value.valueOf();
      }
      const { aliasDuplicateObjects, onAnchor, onTagObj, schema, sourceObjects } = ctx;
      let ref = void 0;
      if (aliasDuplicateObjects && value && typeof value === "object") {
        ref = sourceObjects.get(value);
        if (ref) {
          ref.anchor ?? (ref.anchor = onAnchor(value));
          return new Alias.Alias(ref.anchor);
        } else {
          ref = { anchor: null, node: null };
          sourceObjects.set(value, ref);
        }
      }
      if (tagName?.startsWith("!!"))
        tagName = defaultTagPrefix + tagName.slice(2);
      let tagObj = findTagObject(value, tagName, schema.tags);
      if (!tagObj) {
        if (value && typeof value.toJSON === "function") {
          value = value.toJSON();
        }
        if (!value || typeof value !== "object") {
          const node3 = new Scalar.Scalar(value);
          if (ref)
            ref.node = node3;
          return node3;
        }
        tagObj = value instanceof Map ? schema[identity.MAP] : Symbol.iterator in Object(value) ? schema[identity.SEQ] : schema[identity.MAP];
      }
      if (onTagObj) {
        onTagObj(tagObj);
        delete ctx.onTagObj;
      }
      const node2 = tagObj?.createNode ? tagObj.createNode(ctx.schema, value, ctx) : typeof tagObj?.nodeClass?.from === "function" ? tagObj.nodeClass.from(ctx.schema, value, ctx) : new Scalar.Scalar(value);
      if (tagName)
        node2.tag = tagName;
      else if (!tagObj.default)
        node2.tag = tagObj.tag;
      if (ref)
        ref.node = node2;
      return node2;
    }
    exports.createNode = createNode;
  }
});

// node_modules/yaml/dist/nodes/Collection.js
var require_Collection = __commonJS({
  "node_modules/yaml/dist/nodes/Collection.js"(exports) {
    "use strict";
    var createNode = require_createNode();
    var identity = require_identity();
    var Node = require_Node();
    function collectionFromPath(schema, path2, value) {
      let v = value;
      for (let i = path2.length - 1; i >= 0; --i) {
        const k = path2[i];
        if (typeof k === "number" && Number.isInteger(k) && k >= 0) {
          const a = [];
          a[k] = v;
          v = a;
        } else {
          v = /* @__PURE__ */ new Map([[k, v]]);
        }
      }
      return createNode.createNode(v, void 0, {
        aliasDuplicateObjects: false,
        keepUndefined: false,
        onAnchor: () => {
          throw new Error("This should not happen, please report a bug.");
        },
        schema,
        sourceObjects: /* @__PURE__ */ new Map()
      });
    }
    var isEmptyPath = (path2) => path2 == null || typeof path2 === "object" && !!path2[Symbol.iterator]().next().done;
    var Collection = class extends Node.NodeBase {
      constructor(type, schema) {
        super(type);
        Object.defineProperty(this, "schema", {
          value: schema,
          configurable: true,
          enumerable: false,
          writable: true
        });
      }
      /**
       * Create a copy of this collection.
       *
       * @param schema - If defined, overwrites the original's schema
       */
      clone(schema) {
        const copy = Object.create(Object.getPrototypeOf(this), Object.getOwnPropertyDescriptors(this));
        if (schema)
          copy.schema = schema;
        copy.items = copy.items.map((it) => identity.isNode(it) || identity.isPair(it) ? it.clone(schema) : it);
        if (this.range)
          copy.range = this.range.slice();
        return copy;
      }
      /**
       * Adds a value to the collection. For `!!map` and `!!omap` the value must
       * be a Pair instance or a `{ key, value }` object, which may not have a key
       * that already exists in the map.
       */
      addIn(path2, value) {
        if (isEmptyPath(path2))
          this.add(value);
        else {
          const [key, ...rest] = path2;
          const node2 = this.get(key, true);
          if (identity.isCollection(node2))
            node2.addIn(rest, value);
          else if (node2 === void 0 && this.schema)
            this.set(key, collectionFromPath(this.schema, rest, value));
          else
            throw new Error(`Expected YAML collection at ${key}. Remaining path: ${rest}`);
        }
      }
      /**
       * Removes a value from the collection.
       * @returns `true` if the item was found and removed.
       */
      deleteIn(path2) {
        const [key, ...rest] = path2;
        if (rest.length === 0)
          return this.delete(key);
        const node2 = this.get(key, true);
        if (identity.isCollection(node2))
          return node2.deleteIn(rest);
        else
          throw new Error(`Expected YAML collection at ${key}. Remaining path: ${rest}`);
      }
      /**
       * Returns item at `key`, or `undefined` if not found. By default unwraps
       * scalar values from their surrounding node; to disable set `keepScalar` to
       * `true` (collections are always returned intact).
       */
      getIn(path2, keepScalar) {
        const [key, ...rest] = path2;
        const node2 = this.get(key, true);
        if (rest.length === 0)
          return !keepScalar && identity.isScalar(node2) ? node2.value : node2;
        else
          return identity.isCollection(node2) ? node2.getIn(rest, keepScalar) : void 0;
      }
      hasAllNullValues(allowScalar) {
        return this.items.every((node2) => {
          if (!identity.isPair(node2))
            return false;
          const n = node2.value;
          return n == null || allowScalar && identity.isScalar(n) && n.value == null && !n.commentBefore && !n.comment && !n.tag;
        });
      }
      /**
       * Checks if the collection includes a value with the key `key`.
       */
      hasIn(path2) {
        const [key, ...rest] = path2;
        if (rest.length === 0)
          return this.has(key);
        const node2 = this.get(key, true);
        return identity.isCollection(node2) ? node2.hasIn(rest) : false;
      }
      /**
       * Sets a value in this collection. For `!!set`, `value` needs to be a
       * boolean to add/remove the item from the set.
       */
      setIn(path2, value) {
        const [key, ...rest] = path2;
        if (rest.length === 0) {
          this.set(key, value);
        } else {
          const node2 = this.get(key, true);
          if (identity.isCollection(node2))
            node2.setIn(rest, value);
          else if (node2 === void 0 && this.schema)
            this.set(key, collectionFromPath(this.schema, rest, value));
          else
            throw new Error(`Expected YAML collection at ${key}. Remaining path: ${rest}`);
        }
      }
    };
    exports.Collection = Collection;
    exports.collectionFromPath = collectionFromPath;
    exports.isEmptyPath = isEmptyPath;
  }
});

// node_modules/yaml/dist/stringify/stringifyComment.js
var require_stringifyComment = __commonJS({
  "node_modules/yaml/dist/stringify/stringifyComment.js"(exports) {
    "use strict";
    var stringifyComment = (str) => str.replace(/^(?!$)(?: $)?/gm, "#");
    function indentComment(comment, indent2) {
      if (/^\n+$/.test(comment))
        return comment.substring(1);
      return indent2 ? comment.replace(/^(?! *$)/gm, indent2) : comment;
    }
    var lineComment = (str, indent2, comment) => str.endsWith("\n") ? indentComment(comment, indent2) : comment.includes("\n") ? "\n" + indentComment(comment, indent2) : (str.endsWith(" ") ? "" : " ") + comment;
    exports.indentComment = indentComment;
    exports.lineComment = lineComment;
    exports.stringifyComment = stringifyComment;
  }
});

// node_modules/yaml/dist/stringify/foldFlowLines.js
var require_foldFlowLines = __commonJS({
  "node_modules/yaml/dist/stringify/foldFlowLines.js"(exports) {
    "use strict";
    var FOLD_FLOW = "flow";
    var FOLD_BLOCK = "block";
    var FOLD_QUOTED = "quoted";
    function foldFlowLines(text4, indent2, mode = "flow", { indentAtStart, lineWidth = 80, minContentWidth = 20, onFold, onOverflow } = {}) {
      if (!lineWidth || lineWidth < 0)
        return text4;
      if (lineWidth < minContentWidth)
        minContentWidth = 0;
      const endStep = Math.max(1 + minContentWidth, 1 + lineWidth - indent2.length);
      if (text4.length <= endStep)
        return text4;
      const folds = [];
      const escapedFolds = {};
      let end2 = lineWidth - indent2.length;
      if (typeof indentAtStart === "number") {
        if (indentAtStart > lineWidth - Math.max(2, minContentWidth))
          folds.push(0);
        else
          end2 = lineWidth - indentAtStart;
      }
      let split = void 0;
      let prev = void 0;
      let overflow = false;
      let i = -1;
      let escStart = -1;
      let escEnd = -1;
      if (mode === FOLD_BLOCK) {
        i = consumeMoreIndentedLines(text4, i, indent2.length);
        if (i !== -1)
          end2 = i + endStep;
      }
      for (let ch; ch = text4[i += 1]; ) {
        if (mode === FOLD_QUOTED && ch === "\\") {
          escStart = i;
          switch (text4[i + 1]) {
            case "x":
              i += 3;
              break;
            case "u":
              i += 5;
              break;
            case "U":
              i += 9;
              break;
            default:
              i += 1;
          }
          escEnd = i;
        }
        if (ch === "\n") {
          if (mode === FOLD_BLOCK)
            i = consumeMoreIndentedLines(text4, i, indent2.length);
          end2 = i + indent2.length + endStep;
          split = void 0;
        } else {
          if (ch === " " && prev && prev !== " " && prev !== "\n" && prev !== "	") {
            const next = text4[i + 1];
            if (next && next !== " " && next !== "\n" && next !== "	")
              split = i;
          }
          if (i >= end2) {
            if (split) {
              folds.push(split);
              end2 = split + endStep;
              split = void 0;
            } else if (mode === FOLD_QUOTED) {
              while (prev === " " || prev === "	") {
                prev = ch;
                ch = text4[i += 1];
                overflow = true;
              }
              const j = i > escEnd + 1 ? i - 2 : escStart - 1;
              if (escapedFolds[j])
                return text4;
              folds.push(j);
              escapedFolds[j] = true;
              end2 = j + endStep;
              split = void 0;
            } else {
              overflow = true;
            }
          }
        }
        prev = ch;
      }
      if (overflow && onOverflow)
        onOverflow();
      if (folds.length === 0)
        return text4;
      if (onFold)
        onFold();
      let res = text4.slice(0, folds[0]);
      for (let i2 = 0; i2 < folds.length; ++i2) {
        const fold = folds[i2];
        const end3 = folds[i2 + 1] || text4.length;
        if (fold === 0)
          res = `
${indent2}${text4.slice(0, end3)}`;
        else {
          if (mode === FOLD_QUOTED && escapedFolds[fold])
            res += `${text4[fold]}\\`;
          res += `
${indent2}${text4.slice(fold + 1, end3)}`;
        }
      }
      return res;
    }
    function consumeMoreIndentedLines(text4, i, indent2) {
      let end2 = i;
      let start2 = i + 1;
      let ch = text4[start2];
      while (ch === " " || ch === "	") {
        if (i < start2 + indent2) {
          ch = text4[++i];
        } else {
          do {
            ch = text4[++i];
          } while (ch && ch !== "\n");
          end2 = i;
          start2 = i + 1;
          ch = text4[start2];
        }
      }
      return end2;
    }
    exports.FOLD_BLOCK = FOLD_BLOCK;
    exports.FOLD_FLOW = FOLD_FLOW;
    exports.FOLD_QUOTED = FOLD_QUOTED;
    exports.foldFlowLines = foldFlowLines;
  }
});

// node_modules/yaml/dist/stringify/stringifyString.js
var require_stringifyString = __commonJS({
  "node_modules/yaml/dist/stringify/stringifyString.js"(exports) {
    "use strict";
    var Scalar = require_Scalar();
    var foldFlowLines = require_foldFlowLines();
    var getFoldOptions = (ctx, isBlock) => ({
      indentAtStart: isBlock ? ctx.indent.length : ctx.indentAtStart,
      lineWidth: ctx.options.lineWidth,
      minContentWidth: ctx.options.minContentWidth
    });
    var containsDocumentMarker = (str) => /^(%|---|\.\.\.)/m.test(str);
    function lineLengthOverLimit(str, lineWidth, indentLength) {
      if (!lineWidth || lineWidth < 0)
        return false;
      const limit = lineWidth - indentLength;
      const strLen = str.length;
      if (strLen <= limit)
        return false;
      for (let i = 0, start2 = 0; i < strLen; ++i) {
        if (str[i] === "\n") {
          if (i - start2 > limit)
            return true;
          start2 = i + 1;
          if (strLen - start2 <= limit)
            return false;
        }
      }
      return true;
    }
    function doubleQuotedString(value, ctx) {
      const json = JSON.stringify(value);
      if (ctx.options.doubleQuotedAsJSON)
        return json;
      const { implicitKey } = ctx;
      const minMultiLineLength = ctx.options.doubleQuotedMinMultiLineLength;
      const indent2 = ctx.indent || (containsDocumentMarker(value) ? "  " : "");
      let str = "";
      let start2 = 0;
      for (let i = 0, ch = json[i]; ch; ch = json[++i]) {
        if (ch === " " && json[i + 1] === "\\" && json[i + 2] === "n") {
          str += json.slice(start2, i) + "\\ ";
          i += 1;
          start2 = i;
          ch = "\\";
        }
        if (ch === "\\")
          switch (json[i + 1]) {
            case "u":
              {
                str += json.slice(start2, i);
                const code2 = json.substr(i + 2, 4);
                switch (code2) {
                  case "0000":
                    str += "\\0";
                    break;
                  case "0007":
                    str += "\\a";
                    break;
                  case "000b":
                    str += "\\v";
                    break;
                  case "001b":
                    str += "\\e";
                    break;
                  case "0085":
                    str += "\\N";
                    break;
                  case "00a0":
                    str += "\\_";
                    break;
                  case "2028":
                    str += "\\L";
                    break;
                  case "2029":
                    str += "\\P";
                    break;
                  default:
                    if (code2.substr(0, 2) === "00")
                      str += "\\x" + code2.substr(2);
                    else
                      str += json.substr(i, 6);
                }
                i += 5;
                start2 = i + 1;
              }
              break;
            case "n":
              if (implicitKey || json[i + 2] === '"' || json.length < minMultiLineLength) {
                i += 1;
              } else {
                str += json.slice(start2, i) + "\n\n";
                while (json[i + 2] === "\\" && json[i + 3] === "n" && json[i + 4] !== '"') {
                  str += "\n";
                  i += 2;
                }
                str += indent2;
                if (json[i + 2] === " ")
                  str += "\\";
                i += 1;
                start2 = i + 1;
              }
              break;
            default:
              i += 1;
          }
      }
      str = start2 ? str + json.slice(start2) : json;
      return implicitKey ? str : foldFlowLines.foldFlowLines(str, indent2, foldFlowLines.FOLD_QUOTED, getFoldOptions(ctx, false));
    }
    function singleQuotedString(value, ctx) {
      if (ctx.options.singleQuote === false || ctx.implicitKey && value.includes("\n") || /[ \t]\n|\n[ \t]/.test(value))
        return doubleQuotedString(value, ctx);
      const indent2 = ctx.indent || (containsDocumentMarker(value) ? "  " : "");
      const res = "'" + value.replace(/'/g, "''").replace(/\n+/g, `$&
${indent2}`) + "'";
      return ctx.implicitKey ? res : foldFlowLines.foldFlowLines(res, indent2, foldFlowLines.FOLD_FLOW, getFoldOptions(ctx, false));
    }
    function quotedString(value, ctx) {
      const { singleQuote } = ctx.options;
      let qs;
      if (singleQuote === false)
        qs = doubleQuotedString;
      else {
        const hasDouble = value.includes('"');
        const hasSingle = value.includes("'");
        if (hasDouble && !hasSingle)
          qs = singleQuotedString;
        else if (hasSingle && !hasDouble)
          qs = doubleQuotedString;
        else
          qs = singleQuote ? singleQuotedString : doubleQuotedString;
      }
      return qs(value, ctx);
    }
    var blockEndNewlines;
    try {
      blockEndNewlines = new RegExp("(^|(?<!\n))\n+(?!\n|$)", "g");
    } catch {
      blockEndNewlines = /\n+(?!\n|$)/g;
    }
    function blockString({ comment, type, value }, ctx, onComment, onChompKeep) {
      const { blockQuote: blockQuote2, commentString, lineWidth } = ctx.options;
      if (!blockQuote2 || /\n[\t ]+$/.test(value)) {
        return quotedString(value, ctx);
      }
      const indent2 = ctx.indent || (ctx.forceBlockIndent || containsDocumentMarker(value) ? "  " : "");
      const literal = blockQuote2 === "literal" ? true : blockQuote2 === "folded" || type === Scalar.Scalar.BLOCK_FOLDED ? false : type === Scalar.Scalar.BLOCK_LITERAL ? true : !lineLengthOverLimit(value, lineWidth, indent2.length);
      if (!value)
        return literal ? "|\n" : ">\n";
      let chomp;
      let endStart;
      for (endStart = value.length; endStart > 0; --endStart) {
        const ch = value[endStart - 1];
        if (ch !== "\n" && ch !== "	" && ch !== " ")
          break;
      }
      let end2 = value.substring(endStart);
      const endNlPos = end2.indexOf("\n");
      if (endNlPos === -1) {
        chomp = "-";
      } else if (value === end2 || endNlPos !== end2.length - 1) {
        chomp = "+";
        if (onChompKeep)
          onChompKeep();
      } else {
        chomp = "";
      }
      if (end2) {
        value = value.slice(0, -end2.length);
        if (end2[end2.length - 1] === "\n")
          end2 = end2.slice(0, -1);
        end2 = end2.replace(blockEndNewlines, `$&${indent2}`);
      }
      let startWithSpace = false;
      let startEnd;
      let startNlPos = -1;
      for (startEnd = 0; startEnd < value.length; ++startEnd) {
        const ch = value[startEnd];
        if (ch === " ")
          startWithSpace = true;
        else if (ch === "\n")
          startNlPos = startEnd;
        else
          break;
      }
      let start2 = value.substring(0, startNlPos < startEnd ? startNlPos + 1 : startEnd);
      if (start2) {
        value = value.substring(start2.length);
        start2 = start2.replace(/\n+/g, `$&${indent2}`);
      }
      const indentSize = indent2 ? "2" : "1";
      let header = (startWithSpace ? indentSize : "") + chomp;
      if (comment) {
        header += " " + commentString(comment.replace(/ ?[\r\n]+/g, " "));
        if (onComment)
          onComment();
      }
      if (!literal) {
        const foldedValue = value.replace(/\n+/g, "\n$&").replace(/(?:^|\n)([\t ].*)(?:([\n\t ]*)\n(?![\n\t ]))?/g, "$1$2").replace(/\n+/g, `$&${indent2}`);
        let literalFallback = false;
        const foldOptions = getFoldOptions(ctx, true);
        if (blockQuote2 !== "folded" && type !== Scalar.Scalar.BLOCK_FOLDED) {
          foldOptions.onOverflow = () => {
            literalFallback = true;
          };
        }
        const body2 = foldFlowLines.foldFlowLines(`${start2}${foldedValue}${end2}`, indent2, foldFlowLines.FOLD_BLOCK, foldOptions);
        if (!literalFallback)
          return `>${header}
${indent2}${body2}`;
      }
      value = value.replace(/\n+/g, `$&${indent2}`);
      return `|${header}
${indent2}${start2}${value}${end2}`;
    }
    function plainString(item, ctx, onComment, onChompKeep) {
      const { type, value } = item;
      const { actualString, implicitKey, indent: indent2, indentStep, inFlow } = ctx;
      if (implicitKey && value.includes("\n") || inFlow && /[[\]{},]/.test(value)) {
        return quotedString(value, ctx);
      }
      if (/^[\n\t ,[\]{}#&*!|>'"%@`]|^[?-]$|^[?-][ \t]|[\n:][ \t]|[ \t]\n|[\n\t ]#|[\n\t :]$/.test(value)) {
        return implicitKey || inFlow || !value.includes("\n") ? quotedString(value, ctx) : blockString(item, ctx, onComment, onChompKeep);
      }
      if (!implicitKey && !inFlow && type !== Scalar.Scalar.PLAIN && value.includes("\n")) {
        return blockString(item, ctx, onComment, onChompKeep);
      }
      if (containsDocumentMarker(value)) {
        if (indent2 === "") {
          ctx.forceBlockIndent = true;
          return blockString(item, ctx, onComment, onChompKeep);
        } else if (implicitKey && indent2 === indentStep) {
          return quotedString(value, ctx);
        }
      }
      const str = value.replace(/\n+/g, `$&
${indent2}`);
      if (actualString) {
        const test = (tag) => tag.default && tag.tag !== "tag:yaml.org,2002:str" && tag.test?.test(str);
        const { compat, tags } = ctx.doc.schema;
        if (tags.some(test) || compat?.some(test))
          return quotedString(value, ctx);
      }
      return implicitKey ? str : foldFlowLines.foldFlowLines(str, indent2, foldFlowLines.FOLD_FLOW, getFoldOptions(ctx, false));
    }
    function stringifyString(item, ctx, onComment, onChompKeep) {
      const { implicitKey, inFlow } = ctx;
      const ss = typeof item.value === "string" ? item : Object.assign({}, item, { value: String(item.value) });
      let { type } = item;
      if (type !== Scalar.Scalar.QUOTE_DOUBLE) {
        if (/[\x00-\x08\x0b-\x1f\x7f-\x9f\u{D800}-\u{DFFF}]/u.test(ss.value))
          type = Scalar.Scalar.QUOTE_DOUBLE;
      }
      const _stringify = (_type) => {
        switch (_type) {
          case Scalar.Scalar.BLOCK_FOLDED:
          case Scalar.Scalar.BLOCK_LITERAL:
            return implicitKey || inFlow ? quotedString(ss.value, ctx) : blockString(ss, ctx, onComment, onChompKeep);
          case Scalar.Scalar.QUOTE_DOUBLE:
            return doubleQuotedString(ss.value, ctx);
          case Scalar.Scalar.QUOTE_SINGLE:
            return singleQuotedString(ss.value, ctx);
          case Scalar.Scalar.PLAIN:
            return plainString(ss, ctx, onComment, onChompKeep);
          default:
            return null;
        }
      };
      let res = _stringify(type);
      if (res === null) {
        const { defaultKeyType, defaultStringType } = ctx.options;
        const t = implicitKey && defaultKeyType || defaultStringType;
        res = _stringify(t);
        if (res === null)
          throw new Error(`Unsupported default string type ${t}`);
      }
      return res;
    }
    exports.stringifyString = stringifyString;
  }
});

// node_modules/yaml/dist/stringify/stringify.js
var require_stringify = __commonJS({
  "node_modules/yaml/dist/stringify/stringify.js"(exports) {
    "use strict";
    var anchors = require_anchors();
    var identity = require_identity();
    var stringifyComment = require_stringifyComment();
    var stringifyString = require_stringifyString();
    function createStringifyContext(doc, options) {
      const opt = Object.assign({
        blockQuote: true,
        commentString: stringifyComment.stringifyComment,
        defaultKeyType: null,
        defaultStringType: "PLAIN",
        directives: null,
        doubleQuotedAsJSON: false,
        doubleQuotedMinMultiLineLength: 40,
        falseStr: "false",
        flowCollectionPadding: true,
        indentSeq: true,
        lineWidth: 80,
        minContentWidth: 20,
        nullStr: "null",
        simpleKeys: false,
        singleQuote: null,
        trailingComma: false,
        trueStr: "true",
        verifyAliasOrder: true
      }, doc.schema.toStringOptions, options);
      let inFlow;
      switch (opt.collectionStyle) {
        case "block":
          inFlow = false;
          break;
        case "flow":
          inFlow = true;
          break;
        default:
          inFlow = null;
      }
      return {
        anchors: /* @__PURE__ */ new Set(),
        doc,
        flowCollectionPadding: opt.flowCollectionPadding ? " " : "",
        indent: "",
        indentStep: typeof opt.indent === "number" ? " ".repeat(opt.indent) : "  ",
        inFlow,
        options: opt
      };
    }
    function getTagObject(tags, item) {
      if (item.tag) {
        const match = tags.filter((t) => t.tag === item.tag);
        if (match.length > 0)
          return match.find((t) => t.format === item.format) ?? match[0];
      }
      let tagObj = void 0;
      let obj;
      if (identity.isScalar(item)) {
        obj = item.value;
        let match = tags.filter((t) => t.identify?.(obj));
        if (match.length > 1) {
          const testMatch = match.filter((t) => t.test);
          if (testMatch.length > 0)
            match = testMatch;
        }
        tagObj = match.find((t) => t.format === item.format) ?? match.find((t) => !t.format);
      } else {
        obj = item;
        tagObj = tags.find((t) => t.nodeClass && obj instanceof t.nodeClass);
      }
      if (!tagObj) {
        const name = obj?.constructor?.name ?? (obj === null ? "null" : typeof obj);
        throw new Error(`Tag not resolved for ${name} value`);
      }
      return tagObj;
    }
    function stringifyProps(node2, tagObj, { anchors: anchors$1, doc }) {
      if (!doc.directives)
        return "";
      const props = [];
      const anchor = (identity.isScalar(node2) || identity.isCollection(node2)) && node2.anchor;
      if (anchor && anchors.anchorIsValid(anchor)) {
        anchors$1.add(anchor);
        props.push(`&${anchor}`);
      }
      const tag = node2.tag ?? (tagObj.default ? null : tagObj.tag);
      if (tag)
        props.push(doc.directives.tagString(tag));
      return props.join(" ");
    }
    function stringify2(item, ctx, onComment, onChompKeep) {
      if (identity.isPair(item))
        return item.toString(ctx, onComment, onChompKeep);
      if (identity.isAlias(item)) {
        if (ctx.doc.directives)
          return item.toString(ctx);
        if (ctx.resolvedAliases?.has(item)) {
          throw new TypeError(`Cannot stringify circular structure without alias nodes`);
        } else {
          if (ctx.resolvedAliases)
            ctx.resolvedAliases.add(item);
          else
            ctx.resolvedAliases = /* @__PURE__ */ new Set([item]);
          item = item.resolve(ctx.doc);
        }
      }
      let tagObj = void 0;
      const node2 = identity.isNode(item) ? item : ctx.doc.createNode(item, { onTagObj: (o) => tagObj = o });
      tagObj ?? (tagObj = getTagObject(ctx.doc.schema.tags, node2));
      const props = stringifyProps(node2, tagObj, ctx);
      if (props.length > 0)
        ctx.indentAtStart = (ctx.indentAtStart ?? 0) + props.length + 1;
      const str = typeof tagObj.stringify === "function" ? tagObj.stringify(node2, ctx, onComment, onChompKeep) : identity.isScalar(node2) ? stringifyString.stringifyString(node2, ctx, onComment, onChompKeep) : node2.toString(ctx, onComment, onChompKeep);
      if (!props)
        return str;
      return identity.isScalar(node2) || str[0] === "{" || str[0] === "[" ? `${props} ${str}` : `${props}
${ctx.indent}${str}`;
    }
    exports.createStringifyContext = createStringifyContext;
    exports.stringify = stringify2;
  }
});

// node_modules/yaml/dist/stringify/stringifyPair.js
var require_stringifyPair = __commonJS({
  "node_modules/yaml/dist/stringify/stringifyPair.js"(exports) {
    "use strict";
    var identity = require_identity();
    var Scalar = require_Scalar();
    var stringify2 = require_stringify();
    var stringifyComment = require_stringifyComment();
    function stringifyPair({ key, value }, ctx, onComment, onChompKeep) {
      const { allNullValues, doc, indent: indent2, indentStep, options: { commentString, indentSeq, simpleKeys } } = ctx;
      let keyComment = identity.isNode(key) && key.comment || null;
      if (simpleKeys) {
        if (keyComment) {
          throw new Error("With simple keys, key nodes cannot have comments");
        }
        if (identity.isCollection(key) || !identity.isNode(key) && typeof key === "object") {
          const msg = "With simple keys, collection cannot be used as a key value";
          throw new Error(msg);
        }
      }
      let explicitKey = !simpleKeys && (!key || keyComment && value == null && !ctx.inFlow || identity.isCollection(key) || (identity.isScalar(key) ? key.type === Scalar.Scalar.BLOCK_FOLDED || key.type === Scalar.Scalar.BLOCK_LITERAL : typeof key === "object"));
      ctx = Object.assign({}, ctx, {
        allNullValues: false,
        implicitKey: !explicitKey && (simpleKeys || !allNullValues),
        indent: indent2 + indentStep
      });
      let keyCommentDone = false;
      let chompKeep = false;
      let str = stringify2.stringify(key, ctx, () => keyCommentDone = true, () => chompKeep = true);
      if (!explicitKey && !ctx.inFlow && str.length > 1024) {
        if (simpleKeys)
          throw new Error("With simple keys, single line scalar must not span more than 1024 characters");
        explicitKey = true;
      }
      if (ctx.inFlow) {
        if (allNullValues || value == null) {
          if (keyCommentDone && onComment)
            onComment();
          return str === "" ? "?" : explicitKey ? `? ${str}` : str;
        }
      } else if (allNullValues && !simpleKeys || value == null && explicitKey) {
        str = `? ${str}`;
        if (keyComment && !keyCommentDone) {
          str += stringifyComment.lineComment(str, ctx.indent, commentString(keyComment));
        } else if (chompKeep && onChompKeep)
          onChompKeep();
        return str;
      }
      if (keyCommentDone)
        keyComment = null;
      if (explicitKey) {
        if (keyComment)
          str += stringifyComment.lineComment(str, ctx.indent, commentString(keyComment));
        str = `? ${str}
${indent2}:`;
      } else {
        str = `${str}:`;
        if (keyComment)
          str += stringifyComment.lineComment(str, ctx.indent, commentString(keyComment));
      }
      let vsb, vcb, valueComment;
      if (identity.isNode(value)) {
        vsb = !!value.spaceBefore;
        vcb = value.commentBefore;
        valueComment = value.comment;
      } else {
        vsb = false;
        vcb = null;
        valueComment = null;
        if (value && typeof value === "object")
          value = doc.createNode(value);
      }
      ctx.implicitKey = false;
      if (!explicitKey && !keyComment && identity.isScalar(value))
        ctx.indentAtStart = str.length + 1;
      chompKeep = false;
      if (!indentSeq && indentStep.length >= 2 && !ctx.inFlow && !explicitKey && identity.isSeq(value) && !value.flow && !value.tag && !value.anchor) {
        ctx.indent = ctx.indent.substring(2);
      }
      let valueCommentDone = false;
      const valueStr = stringify2.stringify(value, ctx, () => valueCommentDone = true, () => chompKeep = true);
      let ws = " ";
      if (keyComment || vsb || vcb) {
        ws = vsb ? "\n" : "";
        if (vcb) {
          const cs = commentString(vcb);
          ws += `
${stringifyComment.indentComment(cs, ctx.indent)}`;
        }
        if (valueStr === "" && !ctx.inFlow) {
          if (ws === "\n" && valueComment)
            ws = "\n\n";
        } else {
          ws += `
${ctx.indent}`;
        }
      } else if (!explicitKey && identity.isCollection(value)) {
        const vs0 = valueStr[0];
        const nl0 = valueStr.indexOf("\n");
        const hasNewline = nl0 !== -1;
        const flow3 = ctx.inFlow ?? value.flow ?? value.items.length === 0;
        if (hasNewline || !flow3) {
          let hasPropsLine = false;
          if (hasNewline && (vs0 === "&" || vs0 === "!")) {
            let sp0 = valueStr.indexOf(" ");
            if (vs0 === "&" && sp0 !== -1 && sp0 < nl0 && valueStr[sp0 + 1] === "!") {
              sp0 = valueStr.indexOf(" ", sp0 + 1);
            }
            if (sp0 === -1 || nl0 < sp0)
              hasPropsLine = true;
          }
          if (!hasPropsLine)
            ws = `
${ctx.indent}`;
        }
      } else if (valueStr === "" || valueStr[0] === "\n") {
        ws = "";
      }
      str += ws + valueStr;
      if (ctx.inFlow) {
        if (valueCommentDone && onComment)
          onComment();
      } else if (valueComment && !valueCommentDone) {
        str += stringifyComment.lineComment(str, ctx.indent, commentString(valueComment));
      } else if (chompKeep && onChompKeep) {
        onChompKeep();
      }
      return str;
    }
    exports.stringifyPair = stringifyPair;
  }
});

// node_modules/yaml/dist/log.js
var require_log = __commonJS({
  "node_modules/yaml/dist/log.js"(exports) {
    "use strict";
    var node_process = __require("process");
    function debug(logLevel, ...messages) {
      if (logLevel === "debug")
        console.log(...messages);
    }
    function warn(logLevel, warning) {
      if (logLevel === "debug" || logLevel === "warn") {
        if (typeof node_process.emitWarning === "function")
          node_process.emitWarning(warning);
        else
          console.warn(warning);
      }
    }
    exports.debug = debug;
    exports.warn = warn;
  }
});

// node_modules/yaml/dist/schema/yaml-1.1/merge.js
var require_merge = __commonJS({
  "node_modules/yaml/dist/schema/yaml-1.1/merge.js"(exports) {
    "use strict";
    var identity = require_identity();
    var Scalar = require_Scalar();
    var MERGE_KEY = "<<";
    var merge = {
      identify: (value) => value === MERGE_KEY || typeof value === "symbol" && value.description === MERGE_KEY,
      default: "key",
      tag: "tag:yaml.org,2002:merge",
      test: /^<<$/,
      resolve: () => Object.assign(new Scalar.Scalar(Symbol(MERGE_KEY)), {
        addToJSMap: addMergeToJSMap
      }),
      stringify: () => MERGE_KEY
    };
    var isMergeKey = (ctx, key) => (merge.identify(key) || identity.isScalar(key) && (!key.type || key.type === Scalar.Scalar.PLAIN) && merge.identify(key.value)) && ctx?.doc.schema.tags.some((tag) => tag.tag === merge.tag && tag.default);
    function addMergeToJSMap(ctx, map, value) {
      const source = resolveAliasValue(ctx, value);
      if (identity.isSeq(source))
        for (const it of source.items)
          mergeValue(ctx, map, it);
      else if (Array.isArray(source))
        for (const it of source)
          mergeValue(ctx, map, it);
      else
        mergeValue(ctx, map, source);
    }
    function mergeValue(ctx, map, value) {
      const source = resolveAliasValue(ctx, value);
      if (!identity.isMap(source))
        throw new Error("Merge sources must be maps or map aliases");
      const srcMap = source.toJSON(null, ctx, Map);
      for (const [key, value2] of srcMap) {
        if (map instanceof Map) {
          if (!map.has(key))
            map.set(key, value2);
        } else if (map instanceof Set) {
          map.add(key);
        } else if (!Object.prototype.hasOwnProperty.call(map, key)) {
          Object.defineProperty(map, key, {
            value: value2,
            writable: true,
            enumerable: true,
            configurable: true
          });
        }
      }
      return map;
    }
    function resolveAliasValue(ctx, value) {
      return ctx && identity.isAlias(value) ? value.resolve(ctx.doc, ctx) : value;
    }
    exports.addMergeToJSMap = addMergeToJSMap;
    exports.isMergeKey = isMergeKey;
    exports.merge = merge;
  }
});

// node_modules/yaml/dist/nodes/addPairToJSMap.js
var require_addPairToJSMap = __commonJS({
  "node_modules/yaml/dist/nodes/addPairToJSMap.js"(exports) {
    "use strict";
    var log = require_log();
    var merge = require_merge();
    var stringify2 = require_stringify();
    var identity = require_identity();
    var toJS = require_toJS();
    function addPairToJSMap(ctx, map, { key, value }) {
      if (identity.isNode(key) && key.addToJSMap)
        key.addToJSMap(ctx, map, value);
      else if (merge.isMergeKey(ctx, key))
        merge.addMergeToJSMap(ctx, map, value);
      else {
        const jsKey = toJS.toJS(key, "", ctx);
        if (map instanceof Map) {
          map.set(jsKey, toJS.toJS(value, jsKey, ctx));
        } else if (map instanceof Set) {
          map.add(jsKey);
        } else {
          const stringKey = stringifyKey(key, jsKey, ctx);
          const jsValue = toJS.toJS(value, stringKey, ctx);
          if (stringKey in map)
            Object.defineProperty(map, stringKey, {
              value: jsValue,
              writable: true,
              enumerable: true,
              configurable: true
            });
          else
            map[stringKey] = jsValue;
        }
      }
      return map;
    }
    function stringifyKey(key, jsKey, ctx) {
      if (jsKey === null)
        return "";
      if (typeof jsKey !== "object")
        return String(jsKey);
      if (identity.isNode(key) && ctx?.doc) {
        const strCtx = stringify2.createStringifyContext(ctx.doc, {});
        strCtx.anchors = /* @__PURE__ */ new Set();
        for (const node2 of ctx.anchors.keys())
          strCtx.anchors.add(node2.anchor);
        strCtx.inFlow = true;
        strCtx.inStringifyKey = true;
        const strKey = key.toString(strCtx);
        if (!ctx.mapKeyWarned) {
          let jsonStr = JSON.stringify(strKey);
          if (jsonStr.length > 40)
            jsonStr = jsonStr.substring(0, 36) + '..."';
          log.warn(ctx.doc.options.logLevel, `Keys with collection values will be stringified due to JS Object restrictions: ${jsonStr}. Set mapAsMap: true to use object keys.`);
          ctx.mapKeyWarned = true;
        }
        return strKey;
      }
      return JSON.stringify(jsKey);
    }
    exports.addPairToJSMap = addPairToJSMap;
  }
});

// node_modules/yaml/dist/nodes/Pair.js
var require_Pair = __commonJS({
  "node_modules/yaml/dist/nodes/Pair.js"(exports) {
    "use strict";
    var createNode = require_createNode();
    var stringifyPair = require_stringifyPair();
    var addPairToJSMap = require_addPairToJSMap();
    var identity = require_identity();
    function createPair(key, value, ctx) {
      const k = createNode.createNode(key, void 0, ctx);
      const v = createNode.createNode(value, void 0, ctx);
      return new Pair(k, v);
    }
    var Pair = class _Pair {
      constructor(key, value = null) {
        Object.defineProperty(this, identity.NODE_TYPE, { value: identity.PAIR });
        this.key = key;
        this.value = value;
      }
      clone(schema) {
        let { key, value } = this;
        if (identity.isNode(key))
          key = key.clone(schema);
        if (identity.isNode(value))
          value = value.clone(schema);
        return new _Pair(key, value);
      }
      toJSON(_, ctx) {
        const pair = ctx?.mapAsMap ? /* @__PURE__ */ new Map() : {};
        return addPairToJSMap.addPairToJSMap(ctx, pair, this);
      }
      toString(ctx, onComment, onChompKeep) {
        return ctx?.doc ? stringifyPair.stringifyPair(this, ctx, onComment, onChompKeep) : JSON.stringify(this);
      }
    };
    exports.Pair = Pair;
    exports.createPair = createPair;
  }
});

// node_modules/yaml/dist/stringify/stringifyCollection.js
var require_stringifyCollection = __commonJS({
  "node_modules/yaml/dist/stringify/stringifyCollection.js"(exports) {
    "use strict";
    var identity = require_identity();
    var stringify2 = require_stringify();
    var stringifyComment = require_stringifyComment();
    function stringifyCollection(collection, ctx, options) {
      const flow3 = ctx.inFlow ?? collection.flow;
      const stringify3 = flow3 ? stringifyFlowCollection : stringifyBlockCollection;
      return stringify3(collection, ctx, options);
    }
    function stringifyBlockCollection({ comment, items }, ctx, { blockItemPrefix, flowChars, itemIndent, onChompKeep, onComment }) {
      const { indent: indent2, options: { commentString } } = ctx;
      const itemCtx = Object.assign({}, ctx, { indent: itemIndent, type: null });
      let chompKeep = false;
      const lines2 = [];
      for (let i = 0; i < items.length; ++i) {
        const item = items[i];
        let comment2 = null;
        if (identity.isNode(item)) {
          if (!chompKeep && item.spaceBefore)
            lines2.push("");
          addCommentBefore(ctx, lines2, item.commentBefore, chompKeep);
          if (item.comment)
            comment2 = item.comment;
        } else if (identity.isPair(item)) {
          const ik = identity.isNode(item.key) ? item.key : null;
          if (ik) {
            if (!chompKeep && ik.spaceBefore)
              lines2.push("");
            addCommentBefore(ctx, lines2, ik.commentBefore, chompKeep);
          }
        }
        chompKeep = false;
        let str2 = stringify2.stringify(item, itemCtx, () => comment2 = null, () => chompKeep = true);
        if (comment2)
          str2 += stringifyComment.lineComment(str2, itemIndent, commentString(comment2));
        if (chompKeep && comment2)
          chompKeep = false;
        lines2.push(blockItemPrefix + str2);
      }
      let str;
      if (lines2.length === 0) {
        str = flowChars.start + flowChars.end;
      } else {
        str = lines2[0];
        for (let i = 1; i < lines2.length; ++i) {
          const line2 = lines2[i];
          str += line2 ? `
${indent2}${line2}` : "\n";
        }
      }
      if (comment) {
        str += "\n" + stringifyComment.indentComment(commentString(comment), indent2);
        if (onComment)
          onComment();
      } else if (chompKeep && onChompKeep)
        onChompKeep();
      return str;
    }
    function stringifyFlowCollection({ items }, ctx, { flowChars, itemIndent }) {
      const { indent: indent2, indentStep, flowCollectionPadding: fcPadding, options: { commentString } } = ctx;
      itemIndent += indentStep;
      const itemCtx = Object.assign({}, ctx, {
        indent: itemIndent,
        inFlow: true,
        type: null
      });
      let reqNewline = false;
      let linesAtValue = 0;
      const lines2 = [];
      for (let i = 0; i < items.length; ++i) {
        const item = items[i];
        let comment = null;
        if (identity.isNode(item)) {
          if (item.spaceBefore)
            lines2.push("");
          addCommentBefore(ctx, lines2, item.commentBefore, false);
          if (item.comment)
            comment = item.comment;
        } else if (identity.isPair(item)) {
          const ik = identity.isNode(item.key) ? item.key : null;
          if (ik) {
            if (ik.spaceBefore)
              lines2.push("");
            addCommentBefore(ctx, lines2, ik.commentBefore, false);
            if (ik.comment)
              reqNewline = true;
          }
          const iv = identity.isNode(item.value) ? item.value : null;
          if (iv) {
            if (iv.comment)
              comment = iv.comment;
            if (iv.commentBefore)
              reqNewline = true;
          } else if (item.value == null && ik?.comment) {
            comment = ik.comment;
          }
        }
        if (comment)
          reqNewline = true;
        let str = stringify2.stringify(item, itemCtx, () => comment = null);
        reqNewline || (reqNewline = lines2.length > linesAtValue || str.includes("\n"));
        if (i < items.length - 1) {
          str += ",";
        } else if (ctx.options.trailingComma) {
          if (ctx.options.lineWidth > 0) {
            reqNewline || (reqNewline = lines2.reduce((sum, line2) => sum + line2.length + 2, 2) + (str.length + 2) > ctx.options.lineWidth);
          }
          if (reqNewline) {
            str += ",";
          }
        }
        if (comment)
          str += stringifyComment.lineComment(str, itemIndent, commentString(comment));
        lines2.push(str);
        linesAtValue = lines2.length;
      }
      const { start: start2, end: end2 } = flowChars;
      if (lines2.length === 0) {
        return start2 + end2;
      } else {
        if (!reqNewline) {
          const len = lines2.reduce((sum, line2) => sum + line2.length + 2, 2);
          reqNewline = ctx.options.lineWidth > 0 && len > ctx.options.lineWidth;
        }
        if (reqNewline) {
          let str = start2;
          for (const line2 of lines2)
            str += line2 ? `
${indentStep}${indent2}${line2}` : "\n";
          return `${str}
${indent2}${end2}`;
        } else {
          return `${start2}${fcPadding}${lines2.join(" ")}${fcPadding}${end2}`;
        }
      }
    }
    function addCommentBefore({ indent: indent2, options: { commentString } }, lines2, comment, chompKeep) {
      if (comment && chompKeep)
        comment = comment.replace(/^\n+/, "");
      if (comment) {
        const ic = stringifyComment.indentComment(commentString(comment), indent2);
        lines2.push(ic.trimStart());
      }
    }
    exports.stringifyCollection = stringifyCollection;
  }
});

// node_modules/yaml/dist/nodes/YAMLMap.js
var require_YAMLMap = __commonJS({
  "node_modules/yaml/dist/nodes/YAMLMap.js"(exports) {
    "use strict";
    var stringifyCollection = require_stringifyCollection();
    var addPairToJSMap = require_addPairToJSMap();
    var Collection = require_Collection();
    var identity = require_identity();
    var Pair = require_Pair();
    var Scalar = require_Scalar();
    function findPair(items, key) {
      const k = identity.isScalar(key) ? key.value : key;
      for (const it of items) {
        if (identity.isPair(it)) {
          if (it.key === key || it.key === k)
            return it;
          if (identity.isScalar(it.key) && it.key.value === k)
            return it;
        }
      }
      return void 0;
    }
    var YAMLMap = class extends Collection.Collection {
      static get tagName() {
        return "tag:yaml.org,2002:map";
      }
      constructor(schema) {
        super(identity.MAP, schema);
        this.items = [];
      }
      /**
       * A generic collection parsing method that can be extended
       * to other node classes that inherit from YAMLMap
       */
      static from(schema, obj, ctx) {
        const { keepUndefined, replacer } = ctx;
        const map = new this(schema);
        const add = (key, value) => {
          if (typeof replacer === "function")
            value = replacer.call(obj, key, value);
          else if (Array.isArray(replacer) && !replacer.includes(key))
            return;
          if (value !== void 0 || keepUndefined)
            map.items.push(Pair.createPair(key, value, ctx));
        };
        if (obj instanceof Map) {
          for (const [key, value] of obj)
            add(key, value);
        } else if (obj && typeof obj === "object") {
          for (const key of Object.keys(obj))
            add(key, obj[key]);
        }
        if (typeof schema.sortMapEntries === "function") {
          map.items.sort(schema.sortMapEntries);
        }
        return map;
      }
      /**
       * Adds a value to the collection.
       *
       * @param overwrite - If not set `true`, using a key that is already in the
       *   collection will throw. Otherwise, overwrites the previous value.
       */
      add(pair, overwrite) {
        let _pair;
        if (identity.isPair(pair))
          _pair = pair;
        else if (!pair || typeof pair !== "object" || !("key" in pair)) {
          _pair = new Pair.Pair(pair, pair?.value);
        } else
          _pair = new Pair.Pair(pair.key, pair.value);
        const prev = findPair(this.items, _pair.key);
        const sortEntries = this.schema?.sortMapEntries;
        if (prev) {
          if (!overwrite)
            throw new Error(`Key ${_pair.key} already set`);
          if (identity.isScalar(prev.value) && Scalar.isScalarValue(_pair.value))
            prev.value.value = _pair.value;
          else
            prev.value = _pair.value;
        } else if (sortEntries) {
          const i = this.items.findIndex((item) => sortEntries(_pair, item) < 0);
          if (i === -1)
            this.items.push(_pair);
          else
            this.items.splice(i, 0, _pair);
        } else {
          this.items.push(_pair);
        }
      }
      delete(key) {
        const it = findPair(this.items, key);
        if (!it)
          return false;
        const del = this.items.splice(this.items.indexOf(it), 1);
        return del.length > 0;
      }
      get(key, keepScalar) {
        const it = findPair(this.items, key);
        const node2 = it?.value;
        return (!keepScalar && identity.isScalar(node2) ? node2.value : node2) ?? void 0;
      }
      has(key) {
        return !!findPair(this.items, key);
      }
      set(key, value) {
        this.add(new Pair.Pair(key, value), true);
      }
      /**
       * @param ctx - Conversion context, originally set in Document#toJS()
       * @param {Class} Type - If set, forces the returned collection type
       * @returns Instance of Type, Map, or Object
       */
      toJSON(_, ctx, Type) {
        const map = Type ? new Type() : ctx?.mapAsMap ? /* @__PURE__ */ new Map() : {};
        if (ctx?.onCreate)
          ctx.onCreate(map);
        for (const item of this.items)
          addPairToJSMap.addPairToJSMap(ctx, map, item);
        return map;
      }
      toString(ctx, onComment, onChompKeep) {
        if (!ctx)
          return JSON.stringify(this);
        for (const item of this.items) {
          if (!identity.isPair(item))
            throw new Error(`Map items must all be pairs; found ${JSON.stringify(item)} instead`);
        }
        if (!ctx.allNullValues && this.hasAllNullValues(false))
          ctx = Object.assign({}, ctx, { allNullValues: true });
        return stringifyCollection.stringifyCollection(this, ctx, {
          blockItemPrefix: "",
          flowChars: { start: "{", end: "}" },
          itemIndent: ctx.indent || "",
          onChompKeep,
          onComment
        });
      }
    };
    exports.YAMLMap = YAMLMap;
    exports.findPair = findPair;
  }
});

// node_modules/yaml/dist/schema/common/map.js
var require_map = __commonJS({
  "node_modules/yaml/dist/schema/common/map.js"(exports) {
    "use strict";
    var identity = require_identity();
    var YAMLMap = require_YAMLMap();
    var map = {
      collection: "map",
      default: true,
      nodeClass: YAMLMap.YAMLMap,
      tag: "tag:yaml.org,2002:map",
      resolve(map2, onError) {
        if (!identity.isMap(map2))
          onError("Expected a mapping for this tag");
        return map2;
      },
      createNode: (schema, obj, ctx) => YAMLMap.YAMLMap.from(schema, obj, ctx)
    };
    exports.map = map;
  }
});

// node_modules/yaml/dist/nodes/YAMLSeq.js
var require_YAMLSeq = __commonJS({
  "node_modules/yaml/dist/nodes/YAMLSeq.js"(exports) {
    "use strict";
    var createNode = require_createNode();
    var stringifyCollection = require_stringifyCollection();
    var Collection = require_Collection();
    var identity = require_identity();
    var Scalar = require_Scalar();
    var toJS = require_toJS();
    var YAMLSeq = class extends Collection.Collection {
      static get tagName() {
        return "tag:yaml.org,2002:seq";
      }
      constructor(schema) {
        super(identity.SEQ, schema);
        this.items = [];
      }
      add(value) {
        this.items.push(value);
      }
      /**
       * Removes a value from the collection.
       *
       * `key` must contain a representation of an integer for this to succeed.
       * It may be wrapped in a `Scalar`.
       *
       * @returns `true` if the item was found and removed.
       */
      delete(key) {
        const idx = asItemIndex(key);
        if (typeof idx !== "number")
          return false;
        const del = this.items.splice(idx, 1);
        return del.length > 0;
      }
      get(key, keepScalar) {
        const idx = asItemIndex(key);
        if (typeof idx !== "number")
          return void 0;
        const it = this.items[idx];
        return !keepScalar && identity.isScalar(it) ? it.value : it;
      }
      /**
       * Checks if the collection includes a value with the key `key`.
       *
       * `key` must contain a representation of an integer for this to succeed.
       * It may be wrapped in a `Scalar`.
       */
      has(key) {
        const idx = asItemIndex(key);
        return typeof idx === "number" && idx < this.items.length;
      }
      /**
       * Sets a value in this collection. For `!!set`, `value` needs to be a
       * boolean to add/remove the item from the set.
       *
       * If `key` does not contain a representation of an integer, this will throw.
       * It may be wrapped in a `Scalar`.
       */
      set(key, value) {
        const idx = asItemIndex(key);
        if (typeof idx !== "number")
          throw new Error(`Expected a valid index, not ${key}.`);
        const prev = this.items[idx];
        if (identity.isScalar(prev) && Scalar.isScalarValue(value))
          prev.value = value;
        else
          this.items[idx] = value;
      }
      toJSON(_, ctx) {
        const seq = [];
        if (ctx?.onCreate)
          ctx.onCreate(seq);
        let i = 0;
        for (const item of this.items)
          seq.push(toJS.toJS(item, String(i++), ctx));
        return seq;
      }
      toString(ctx, onComment, onChompKeep) {
        if (!ctx)
          return JSON.stringify(this);
        return stringifyCollection.stringifyCollection(this, ctx, {
          blockItemPrefix: "- ",
          flowChars: { start: "[", end: "]" },
          itemIndent: (ctx.indent || "") + "  ",
          onChompKeep,
          onComment
        });
      }
      static from(schema, obj, ctx) {
        const { replacer } = ctx;
        const seq = new this(schema);
        if (obj && Symbol.iterator in Object(obj)) {
          let i = 0;
          for (let it of obj) {
            if (typeof replacer === "function") {
              const key = obj instanceof Set ? it : String(i++);
              it = replacer.call(obj, key, it);
            }
            seq.items.push(createNode.createNode(it, void 0, ctx));
          }
        }
        return seq;
      }
    };
    function asItemIndex(key) {
      let idx = identity.isScalar(key) ? key.value : key;
      if (idx && typeof idx === "string")
        idx = Number(idx);
      return typeof idx === "number" && Number.isInteger(idx) && idx >= 0 ? idx : null;
    }
    exports.YAMLSeq = YAMLSeq;
  }
});

// node_modules/yaml/dist/schema/common/seq.js
var require_seq = __commonJS({
  "node_modules/yaml/dist/schema/common/seq.js"(exports) {
    "use strict";
    var identity = require_identity();
    var YAMLSeq = require_YAMLSeq();
    var seq = {
      collection: "seq",
      default: true,
      nodeClass: YAMLSeq.YAMLSeq,
      tag: "tag:yaml.org,2002:seq",
      resolve(seq2, onError) {
        if (!identity.isSeq(seq2))
          onError("Expected a sequence for this tag");
        return seq2;
      },
      createNode: (schema, obj, ctx) => YAMLSeq.YAMLSeq.from(schema, obj, ctx)
    };
    exports.seq = seq;
  }
});

// node_modules/yaml/dist/schema/common/string.js
var require_string = __commonJS({
  "node_modules/yaml/dist/schema/common/string.js"(exports) {
    "use strict";
    var stringifyString = require_stringifyString();
    var string3 = {
      identify: (value) => typeof value === "string",
      default: true,
      tag: "tag:yaml.org,2002:str",
      resolve: (str) => str,
      stringify(item, ctx, onComment, onChompKeep) {
        ctx = Object.assign({ actualString: true }, ctx);
        return stringifyString.stringifyString(item, ctx, onComment, onChompKeep);
      }
    };
    exports.string = string3;
  }
});

// node_modules/yaml/dist/schema/common/null.js
var require_null = __commonJS({
  "node_modules/yaml/dist/schema/common/null.js"(exports) {
    "use strict";
    var Scalar = require_Scalar();
    var nullTag = {
      identify: (value) => value == null,
      createNode: () => new Scalar.Scalar(null),
      default: true,
      tag: "tag:yaml.org,2002:null",
      test: /^(?:~|[Nn]ull|NULL)?$/,
      resolve: () => new Scalar.Scalar(null),
      stringify: ({ source }, ctx) => typeof source === "string" && nullTag.test.test(source) ? source : ctx.options.nullStr
    };
    exports.nullTag = nullTag;
  }
});

// node_modules/yaml/dist/schema/core/bool.js
var require_bool = __commonJS({
  "node_modules/yaml/dist/schema/core/bool.js"(exports) {
    "use strict";
    var Scalar = require_Scalar();
    var boolTag = {
      identify: (value) => typeof value === "boolean",
      default: true,
      tag: "tag:yaml.org,2002:bool",
      test: /^(?:[Tt]rue|TRUE|[Ff]alse|FALSE)$/,
      resolve: (str) => new Scalar.Scalar(str[0] === "t" || str[0] === "T"),
      stringify({ source, value }, ctx) {
        if (source && boolTag.test.test(source)) {
          const sv = source[0] === "t" || source[0] === "T";
          if (value === sv)
            return source;
        }
        return value ? ctx.options.trueStr : ctx.options.falseStr;
      }
    };
    exports.boolTag = boolTag;
  }
});

// node_modules/yaml/dist/stringify/stringifyNumber.js
var require_stringifyNumber = __commonJS({
  "node_modules/yaml/dist/stringify/stringifyNumber.js"(exports) {
    "use strict";
    function stringifyNumber({ format, minFractionDigits, tag, value }) {
      if (typeof value === "bigint")
        return String(value);
      const num = typeof value === "number" ? value : Number(value);
      if (!isFinite(num))
        return isNaN(num) ? ".nan" : num < 0 ? "-.inf" : ".inf";
      let n = Object.is(value, -0) ? "-0" : JSON.stringify(value);
      if (!format && minFractionDigits && (!tag || tag === "tag:yaml.org,2002:float") && /^-?\d/.test(n) && !n.includes("e")) {
        let i = n.indexOf(".");
        if (i < 0) {
          i = n.length;
          n += ".";
        }
        let d = minFractionDigits - (n.length - i - 1);
        while (d-- > 0)
          n += "0";
      }
      return n;
    }
    exports.stringifyNumber = stringifyNumber;
  }
});

// node_modules/yaml/dist/schema/core/float.js
var require_float = __commonJS({
  "node_modules/yaml/dist/schema/core/float.js"(exports) {
    "use strict";
    var Scalar = require_Scalar();
    var stringifyNumber = require_stringifyNumber();
    var floatNaN = {
      identify: (value) => typeof value === "number",
      default: true,
      tag: "tag:yaml.org,2002:float",
      test: /^(?:[-+]?\.(?:inf|Inf|INF)|\.nan|\.NaN|\.NAN)$/,
      resolve: (str) => str.slice(-3).toLowerCase() === "nan" ? NaN : str[0] === "-" ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY,
      stringify: stringifyNumber.stringifyNumber
    };
    var floatExp = {
      identify: (value) => typeof value === "number",
      default: true,
      tag: "tag:yaml.org,2002:float",
      format: "EXP",
      test: /^[-+]?(?:\.[0-9]+|[0-9]+(?:\.[0-9]*)?)[eE][-+]?[0-9]+$/,
      resolve: (str) => parseFloat(str),
      stringify(node2) {
        const num = Number(node2.value);
        return isFinite(num) ? num.toExponential() : stringifyNumber.stringifyNumber(node2);
      }
    };
    var float = {
      identify: (value) => typeof value === "number",
      default: true,
      tag: "tag:yaml.org,2002:float",
      test: /^[-+]?(?:\.[0-9]+|[0-9]+\.[0-9]*)$/,
      resolve(str) {
        const node2 = new Scalar.Scalar(parseFloat(str));
        const dot = str.indexOf(".");
        if (dot !== -1 && str[str.length - 1] === "0")
          node2.minFractionDigits = str.length - dot - 1;
        return node2;
      },
      stringify: stringifyNumber.stringifyNumber
    };
    exports.float = float;
    exports.floatExp = floatExp;
    exports.floatNaN = floatNaN;
  }
});

// node_modules/yaml/dist/schema/core/int.js
var require_int = __commonJS({
  "node_modules/yaml/dist/schema/core/int.js"(exports) {
    "use strict";
    var stringifyNumber = require_stringifyNumber();
    var intIdentify = (value) => typeof value === "bigint" || Number.isInteger(value);
    var intResolve = (str, offset, radix, { intAsBigInt }) => intAsBigInt ? BigInt(str) : parseInt(str.substring(offset), radix);
    function intStringify(node2, radix, prefix) {
      const { value } = node2;
      if (intIdentify(value) && value >= 0)
        return prefix + value.toString(radix);
      return stringifyNumber.stringifyNumber(node2);
    }
    var intOct = {
      identify: (value) => intIdentify(value) && value >= 0,
      default: true,
      tag: "tag:yaml.org,2002:int",
      format: "OCT",
      test: /^0o[0-7]+$/,
      resolve: (str, _onError, opt) => intResolve(str, 2, 8, opt),
      stringify: (node2) => intStringify(node2, 8, "0o")
    };
    var int = {
      identify: intIdentify,
      default: true,
      tag: "tag:yaml.org,2002:int",
      test: /^[-+]?[0-9]+$/,
      resolve: (str, _onError, opt) => intResolve(str, 0, 10, opt),
      stringify: stringifyNumber.stringifyNumber
    };
    var intHex = {
      identify: (value) => intIdentify(value) && value >= 0,
      default: true,
      tag: "tag:yaml.org,2002:int",
      format: "HEX",
      test: /^0x[0-9a-fA-F]+$/,
      resolve: (str, _onError, opt) => intResolve(str, 2, 16, opt),
      stringify: (node2) => intStringify(node2, 16, "0x")
    };
    exports.int = int;
    exports.intHex = intHex;
    exports.intOct = intOct;
  }
});

// node_modules/yaml/dist/schema/core/schema.js
var require_schema = __commonJS({
  "node_modules/yaml/dist/schema/core/schema.js"(exports) {
    "use strict";
    var map = require_map();
    var _null = require_null();
    var seq = require_seq();
    var string3 = require_string();
    var bool = require_bool();
    var float = require_float();
    var int = require_int();
    var schema = [
      map.map,
      seq.seq,
      string3.string,
      _null.nullTag,
      bool.boolTag,
      int.intOct,
      int.int,
      int.intHex,
      float.floatNaN,
      float.floatExp,
      float.float
    ];
    exports.schema = schema;
  }
});

// node_modules/yaml/dist/schema/json/schema.js
var require_schema2 = __commonJS({
  "node_modules/yaml/dist/schema/json/schema.js"(exports) {
    "use strict";
    var Scalar = require_Scalar();
    var map = require_map();
    var seq = require_seq();
    function intIdentify(value) {
      return typeof value === "bigint" || Number.isInteger(value);
    }
    var stringifyJSON = ({ value }) => JSON.stringify(value);
    var jsonScalars = [
      {
        identify: (value) => typeof value === "string",
        default: true,
        tag: "tag:yaml.org,2002:str",
        resolve: (str) => str,
        stringify: stringifyJSON
      },
      {
        identify: (value) => value == null,
        createNode: () => new Scalar.Scalar(null),
        default: true,
        tag: "tag:yaml.org,2002:null",
        test: /^null$/,
        resolve: () => null,
        stringify: stringifyJSON
      },
      {
        identify: (value) => typeof value === "boolean",
        default: true,
        tag: "tag:yaml.org,2002:bool",
        test: /^true$|^false$/,
        resolve: (str) => str === "true",
        stringify: stringifyJSON
      },
      {
        identify: intIdentify,
        default: true,
        tag: "tag:yaml.org,2002:int",
        test: /^-?(?:0|[1-9][0-9]*)$/,
        resolve: (str, _onError, { intAsBigInt }) => intAsBigInt ? BigInt(str) : parseInt(str, 10),
        stringify: ({ value }) => intIdentify(value) ? value.toString() : JSON.stringify(value)
      },
      {
        identify: (value) => typeof value === "number",
        default: true,
        tag: "tag:yaml.org,2002:float",
        test: /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]*)?(?:[eE][-+]?[0-9]+)?$/,
        resolve: (str) => parseFloat(str),
        stringify: stringifyJSON
      }
    ];
    var jsonError = {
      default: true,
      tag: "",
      test: /^/,
      resolve(str, onError) {
        onError(`Unresolved plain scalar ${JSON.stringify(str)}`);
        return str;
      }
    };
    var schema = [map.map, seq.seq].concat(jsonScalars, jsonError);
    exports.schema = schema;
  }
});

// node_modules/yaml/dist/schema/yaml-1.1/binary.js
var require_binary = __commonJS({
  "node_modules/yaml/dist/schema/yaml-1.1/binary.js"(exports) {
    "use strict";
    var node_buffer = __require("buffer");
    var Scalar = require_Scalar();
    var stringifyString = require_stringifyString();
    var binary = {
      identify: (value) => value instanceof Uint8Array,
      // Buffer inherits from Uint8Array
      default: false,
      tag: "tag:yaml.org,2002:binary",
      /**
       * Returns a Buffer in node and an Uint8Array in browsers
       *
       * To use the resulting buffer as an image, you'll want to do something like:
       *
       *   const blob = new Blob([buffer], { type: 'image/jpeg' })
       *   document.querySelector('#photo').src = URL.createObjectURL(blob)
       */
      resolve(src, onError) {
        if (typeof node_buffer.Buffer === "function") {
          return node_buffer.Buffer.from(src, "base64");
        } else if (typeof atob === "function") {
          const str = atob(src.replace(/[\n\r]/g, ""));
          const buffer = new Uint8Array(str.length);
          for (let i = 0; i < str.length; ++i)
            buffer[i] = str.charCodeAt(i);
          return buffer;
        } else {
          onError("This environment does not support reading binary tags; either Buffer or atob is required");
          return src;
        }
      },
      stringify({ comment, type, value }, ctx, onComment, onChompKeep) {
        if (!value)
          return "";
        const buf = value;
        let str;
        if (typeof node_buffer.Buffer === "function") {
          str = buf instanceof node_buffer.Buffer ? buf.toString("base64") : node_buffer.Buffer.from(buf.buffer).toString("base64");
        } else if (typeof btoa === "function") {
          let s = "";
          for (let i = 0; i < buf.length; ++i)
            s += String.fromCharCode(buf[i]);
          str = btoa(s);
        } else {
          throw new Error("This environment does not support writing binary tags; either Buffer or btoa is required");
        }
        type ?? (type = Scalar.Scalar.BLOCK_LITERAL);
        if (type !== Scalar.Scalar.QUOTE_DOUBLE) {
          const lineWidth = Math.max(ctx.options.lineWidth - ctx.indent.length, ctx.options.minContentWidth);
          const n = Math.ceil(str.length / lineWidth);
          const lines2 = new Array(n);
          for (let i = 0, o = 0; i < n; ++i, o += lineWidth) {
            lines2[i] = str.substr(o, lineWidth);
          }
          str = lines2.join(type === Scalar.Scalar.BLOCK_LITERAL ? "\n" : " ");
        }
        return stringifyString.stringifyString({ comment, type, value: str }, ctx, onComment, onChompKeep);
      }
    };
    exports.binary = binary;
  }
});

// node_modules/yaml/dist/schema/yaml-1.1/pairs.js
var require_pairs = __commonJS({
  "node_modules/yaml/dist/schema/yaml-1.1/pairs.js"(exports) {
    "use strict";
    var identity = require_identity();
    var Pair = require_Pair();
    var Scalar = require_Scalar();
    var YAMLSeq = require_YAMLSeq();
    function resolvePairs(seq, onError) {
      if (identity.isSeq(seq)) {
        for (let i = 0; i < seq.items.length; ++i) {
          let item = seq.items[i];
          if (identity.isPair(item))
            continue;
          else if (identity.isMap(item)) {
            if (item.items.length > 1)
              onError("Each pair must have its own sequence indicator");
            const pair = item.items[0] || new Pair.Pair(new Scalar.Scalar(null));
            if (item.commentBefore)
              pair.key.commentBefore = pair.key.commentBefore ? `${item.commentBefore}
${pair.key.commentBefore}` : item.commentBefore;
            if (item.comment) {
              const cn = pair.value ?? pair.key;
              cn.comment = cn.comment ? `${item.comment}
${cn.comment}` : item.comment;
            }
            item = pair;
          }
          seq.items[i] = identity.isPair(item) ? item : new Pair.Pair(item);
        }
      } else
        onError("Expected a sequence for this tag");
      return seq;
    }
    function createPairs(schema, iterable, ctx) {
      const { replacer } = ctx;
      const pairs2 = new YAMLSeq.YAMLSeq(schema);
      pairs2.tag = "tag:yaml.org,2002:pairs";
      let i = 0;
      if (iterable && Symbol.iterator in Object(iterable))
        for (let it of iterable) {
          if (typeof replacer === "function")
            it = replacer.call(iterable, String(i++), it);
          let key, value;
          if (Array.isArray(it)) {
            if (it.length === 2) {
              key = it[0];
              value = it[1];
            } else
              throw new TypeError(`Expected [key, value] tuple: ${it}`);
          } else if (it && it instanceof Object) {
            const keys = Object.keys(it);
            if (keys.length === 1) {
              key = keys[0];
              value = it[key];
            } else {
              throw new TypeError(`Expected tuple with one key, not ${keys.length} keys`);
            }
          } else {
            key = it;
          }
          pairs2.items.push(Pair.createPair(key, value, ctx));
        }
      return pairs2;
    }
    var pairs = {
      collection: "seq",
      default: false,
      tag: "tag:yaml.org,2002:pairs",
      resolve: resolvePairs,
      createNode: createPairs
    };
    exports.createPairs = createPairs;
    exports.pairs = pairs;
    exports.resolvePairs = resolvePairs;
  }
});

// node_modules/yaml/dist/schema/yaml-1.1/omap.js
var require_omap = __commonJS({
  "node_modules/yaml/dist/schema/yaml-1.1/omap.js"(exports) {
    "use strict";
    var identity = require_identity();
    var toJS = require_toJS();
    var YAMLMap = require_YAMLMap();
    var YAMLSeq = require_YAMLSeq();
    var pairs = require_pairs();
    var YAMLOMap = class _YAMLOMap extends YAMLSeq.YAMLSeq {
      constructor() {
        super();
        this.add = YAMLMap.YAMLMap.prototype.add.bind(this);
        this.delete = YAMLMap.YAMLMap.prototype.delete.bind(this);
        this.get = YAMLMap.YAMLMap.prototype.get.bind(this);
        this.has = YAMLMap.YAMLMap.prototype.has.bind(this);
        this.set = YAMLMap.YAMLMap.prototype.set.bind(this);
        this.tag = _YAMLOMap.tag;
      }
      /**
       * If `ctx` is given, the return type is actually `Map<unknown, unknown>`,
       * but TypeScript won't allow widening the signature of a child method.
       */
      toJSON(_, ctx) {
        if (!ctx)
          return super.toJSON(_);
        const map = /* @__PURE__ */ new Map();
        if (ctx?.onCreate)
          ctx.onCreate(map);
        for (const pair of this.items) {
          let key, value;
          if (identity.isPair(pair)) {
            key = toJS.toJS(pair.key, "", ctx);
            value = toJS.toJS(pair.value, key, ctx);
          } else {
            key = toJS.toJS(pair, "", ctx);
          }
          if (map.has(key))
            throw new Error("Ordered maps must not include duplicate keys");
          map.set(key, value);
        }
        return map;
      }
      static from(schema, iterable, ctx) {
        const pairs$1 = pairs.createPairs(schema, iterable, ctx);
        const omap2 = new this();
        omap2.items = pairs$1.items;
        return omap2;
      }
    };
    YAMLOMap.tag = "tag:yaml.org,2002:omap";
    var omap = {
      collection: "seq",
      identify: (value) => value instanceof Map,
      nodeClass: YAMLOMap,
      default: false,
      tag: "tag:yaml.org,2002:omap",
      resolve(seq, onError) {
        const pairs$1 = pairs.resolvePairs(seq, onError);
        const seenKeys = [];
        for (const { key } of pairs$1.items) {
          if (identity.isScalar(key)) {
            if (seenKeys.includes(key.value)) {
              onError(`Ordered maps must not include duplicate keys: ${key.value}`);
            } else {
              seenKeys.push(key.value);
            }
          }
        }
        return Object.assign(new YAMLOMap(), pairs$1);
      },
      createNode: (schema, iterable, ctx) => YAMLOMap.from(schema, iterable, ctx)
    };
    exports.YAMLOMap = YAMLOMap;
    exports.omap = omap;
  }
});

// node_modules/yaml/dist/schema/yaml-1.1/bool.js
var require_bool2 = __commonJS({
  "node_modules/yaml/dist/schema/yaml-1.1/bool.js"(exports) {
    "use strict";
    var Scalar = require_Scalar();
    function boolStringify({ value, source }, ctx) {
      const boolObj = value ? trueTag : falseTag;
      if (source && boolObj.test.test(source))
        return source;
      return value ? ctx.options.trueStr : ctx.options.falseStr;
    }
    var trueTag = {
      identify: (value) => value === true,
      default: true,
      tag: "tag:yaml.org,2002:bool",
      test: /^(?:Y|y|[Yy]es|YES|[Tt]rue|TRUE|[Oo]n|ON)$/,
      resolve: () => new Scalar.Scalar(true),
      stringify: boolStringify
    };
    var falseTag = {
      identify: (value) => value === false,
      default: true,
      tag: "tag:yaml.org,2002:bool",
      test: /^(?:N|n|[Nn]o|NO|[Ff]alse|FALSE|[Oo]ff|OFF)$/,
      resolve: () => new Scalar.Scalar(false),
      stringify: boolStringify
    };
    exports.falseTag = falseTag;
    exports.trueTag = trueTag;
  }
});

// node_modules/yaml/dist/schema/yaml-1.1/float.js
var require_float2 = __commonJS({
  "node_modules/yaml/dist/schema/yaml-1.1/float.js"(exports) {
    "use strict";
    var Scalar = require_Scalar();
    var stringifyNumber = require_stringifyNumber();
    var floatNaN = {
      identify: (value) => typeof value === "number",
      default: true,
      tag: "tag:yaml.org,2002:float",
      test: /^(?:[-+]?\.(?:inf|Inf|INF)|\.nan|\.NaN|\.NAN)$/,
      resolve: (str) => str.slice(-3).toLowerCase() === "nan" ? NaN : str[0] === "-" ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY,
      stringify: stringifyNumber.stringifyNumber
    };
    var floatExp = {
      identify: (value) => typeof value === "number",
      default: true,
      tag: "tag:yaml.org,2002:float",
      format: "EXP",
      test: /^[-+]?(?:[0-9][0-9_]*)?(?:\.[0-9_]*)?[eE][-+]?[0-9]+$/,
      resolve: (str) => parseFloat(str.replace(/_/g, "")),
      stringify(node2) {
        const num = Number(node2.value);
        return isFinite(num) ? num.toExponential() : stringifyNumber.stringifyNumber(node2);
      }
    };
    var float = {
      identify: (value) => typeof value === "number",
      default: true,
      tag: "tag:yaml.org,2002:float",
      test: /^[-+]?(?:[0-9][0-9_]*)?\.[0-9_]*$/,
      resolve(str) {
        const node2 = new Scalar.Scalar(parseFloat(str.replace(/_/g, "")));
        const dot = str.indexOf(".");
        if (dot !== -1) {
          const f = str.substring(dot + 1).replace(/_/g, "");
          if (f[f.length - 1] === "0")
            node2.minFractionDigits = f.length;
        }
        return node2;
      },
      stringify: stringifyNumber.stringifyNumber
    };
    exports.float = float;
    exports.floatExp = floatExp;
    exports.floatNaN = floatNaN;
  }
});

// node_modules/yaml/dist/schema/yaml-1.1/int.js
var require_int2 = __commonJS({
  "node_modules/yaml/dist/schema/yaml-1.1/int.js"(exports) {
    "use strict";
    var stringifyNumber = require_stringifyNumber();
    var intIdentify = (value) => typeof value === "bigint" || Number.isInteger(value);
    function intResolve(str, offset, radix, { intAsBigInt }) {
      const sign = str[0];
      if (sign === "-" || sign === "+")
        offset += 1;
      str = str.substring(offset).replace(/_/g, "");
      if (intAsBigInt) {
        switch (radix) {
          case 2:
            str = `0b${str}`;
            break;
          case 8:
            str = `0o${str}`;
            break;
          case 16:
            str = `0x${str}`;
            break;
        }
        const n2 = BigInt(str);
        return sign === "-" ? BigInt(-1) * n2 : n2;
      }
      const n = parseInt(str, radix);
      return sign === "-" ? -1 * n : n;
    }
    function intStringify(node2, radix, prefix) {
      const { value } = node2;
      if (intIdentify(value)) {
        const str = value.toString(radix);
        return value < 0 ? "-" + prefix + str.substr(1) : prefix + str;
      }
      return stringifyNumber.stringifyNumber(node2);
    }
    var intBin = {
      identify: intIdentify,
      default: true,
      tag: "tag:yaml.org,2002:int",
      format: "BIN",
      test: /^[-+]?0b[0-1_]+$/,
      resolve: (str, _onError, opt) => intResolve(str, 2, 2, opt),
      stringify: (node2) => intStringify(node2, 2, "0b")
    };
    var intOct = {
      identify: intIdentify,
      default: true,
      tag: "tag:yaml.org,2002:int",
      format: "OCT",
      test: /^[-+]?0[0-7_]+$/,
      resolve: (str, _onError, opt) => intResolve(str, 1, 8, opt),
      stringify: (node2) => intStringify(node2, 8, "0")
    };
    var int = {
      identify: intIdentify,
      default: true,
      tag: "tag:yaml.org,2002:int",
      test: /^[-+]?[0-9][0-9_]*$/,
      resolve: (str, _onError, opt) => intResolve(str, 0, 10, opt),
      stringify: stringifyNumber.stringifyNumber
    };
    var intHex = {
      identify: intIdentify,
      default: true,
      tag: "tag:yaml.org,2002:int",
      format: "HEX",
      test: /^[-+]?0x[0-9a-fA-F_]+$/,
      resolve: (str, _onError, opt) => intResolve(str, 2, 16, opt),
      stringify: (node2) => intStringify(node2, 16, "0x")
    };
    exports.int = int;
    exports.intBin = intBin;
    exports.intHex = intHex;
    exports.intOct = intOct;
  }
});

// node_modules/yaml/dist/schema/yaml-1.1/set.js
var require_set = __commonJS({
  "node_modules/yaml/dist/schema/yaml-1.1/set.js"(exports) {
    "use strict";
    var identity = require_identity();
    var Pair = require_Pair();
    var YAMLMap = require_YAMLMap();
    var YAMLSet = class _YAMLSet extends YAMLMap.YAMLMap {
      constructor(schema) {
        super(schema);
        this.tag = _YAMLSet.tag;
      }
      add(key) {
        let pair;
        if (identity.isPair(key))
          pair = key;
        else if (key && typeof key === "object" && "key" in key && "value" in key && key.value === null)
          pair = new Pair.Pair(key.key, null);
        else
          pair = new Pair.Pair(key, null);
        const prev = YAMLMap.findPair(this.items, pair.key);
        if (!prev)
          this.items.push(pair);
      }
      /**
       * If `keepPair` is `true`, returns the Pair matching `key`.
       * Otherwise, returns the value of that Pair's key.
       */
      get(key, keepPair) {
        const pair = YAMLMap.findPair(this.items, key);
        return !keepPair && identity.isPair(pair) ? identity.isScalar(pair.key) ? pair.key.value : pair.key : pair;
      }
      set(key, value) {
        if (typeof value !== "boolean")
          throw new Error(`Expected boolean value for set(key, value) in a YAML set, not ${typeof value}`);
        const prev = YAMLMap.findPair(this.items, key);
        if (prev && !value) {
          this.items.splice(this.items.indexOf(prev), 1);
        } else if (!prev && value) {
          this.items.push(new Pair.Pair(key));
        }
      }
      toJSON(_, ctx) {
        return super.toJSON(_, ctx, Set);
      }
      toString(ctx, onComment, onChompKeep) {
        if (!ctx)
          return JSON.stringify(this);
        if (this.hasAllNullValues(true))
          return super.toString(Object.assign({}, ctx, { allNullValues: true }), onComment, onChompKeep);
        else
          throw new Error("Set items must all have null values");
      }
      static from(schema, iterable, ctx) {
        const { replacer } = ctx;
        const set2 = new this(schema);
        if (iterable && Symbol.iterator in Object(iterable))
          for (let value of iterable) {
            if (typeof replacer === "function")
              value = replacer.call(iterable, value, value);
            set2.items.push(Pair.createPair(value, null, ctx));
          }
        return set2;
      }
    };
    YAMLSet.tag = "tag:yaml.org,2002:set";
    var set = {
      collection: "map",
      identify: (value) => value instanceof Set,
      nodeClass: YAMLSet,
      default: false,
      tag: "tag:yaml.org,2002:set",
      createNode: (schema, iterable, ctx) => YAMLSet.from(schema, iterable, ctx),
      resolve(map, onError) {
        if (identity.isMap(map)) {
          if (map.hasAllNullValues(true))
            return Object.assign(new YAMLSet(), map);
          else
            onError("Set items must all have null values");
        } else
          onError("Expected a mapping for this tag");
        return map;
      }
    };
    exports.YAMLSet = YAMLSet;
    exports.set = set;
  }
});

// node_modules/yaml/dist/schema/yaml-1.1/timestamp.js
var require_timestamp = __commonJS({
  "node_modules/yaml/dist/schema/yaml-1.1/timestamp.js"(exports) {
    "use strict";
    var stringifyNumber = require_stringifyNumber();
    function parseSexagesimal(str, asBigInt) {
      const sign = str[0];
      const parts = sign === "-" || sign === "+" ? str.substring(1) : str;
      const num = (n) => asBigInt ? BigInt(n) : Number(n);
      const res = parts.replace(/_/g, "").split(":").reduce((res2, p) => res2 * num(60) + num(p), num(0));
      return sign === "-" ? num(-1) * res : res;
    }
    function stringifySexagesimal(node2) {
      let { value } = node2;
      let num = (n) => n;
      if (typeof value === "bigint")
        num = (n) => BigInt(n);
      else if (isNaN(value) || !isFinite(value))
        return stringifyNumber.stringifyNumber(node2);
      let sign = "";
      if (value < 0) {
        sign = "-";
        value *= num(-1);
      }
      const _60 = num(60);
      const parts = [value % _60];
      if (value < 60) {
        parts.unshift(0);
      } else {
        value = (value - parts[0]) / _60;
        parts.unshift(value % _60);
        if (value >= 60) {
          value = (value - parts[0]) / _60;
          parts.unshift(value);
        }
      }
      return sign + parts.map((n) => String(n).padStart(2, "0")).join(":").replace(/000000\d*$/, "");
    }
    var intTime = {
      identify: (value) => typeof value === "bigint" || Number.isInteger(value),
      default: true,
      tag: "tag:yaml.org,2002:int",
      format: "TIME",
      test: /^[-+]?[0-9][0-9_]*(?::[0-5]?[0-9])+$/,
      resolve: (str, _onError, { intAsBigInt }) => parseSexagesimal(str, intAsBigInt),
      stringify: stringifySexagesimal
    };
    var floatTime = {
      identify: (value) => typeof value === "number",
      default: true,
      tag: "tag:yaml.org,2002:float",
      format: "TIME",
      test: /^[-+]?[0-9][0-9_]*(?::[0-5]?[0-9])+\.[0-9_]*$/,
      resolve: (str) => parseSexagesimal(str, false),
      stringify: stringifySexagesimal
    };
    var timestamp = {
      identify: (value) => value instanceof Date,
      default: true,
      tag: "tag:yaml.org,2002:timestamp",
      // If the time zone is omitted, the timestamp is assumed to be specified in UTC. The time part
      // may be omitted altogether, resulting in a date format. In such a case, the time part is
      // assumed to be 00:00:00Z (start of day, UTC).
      test: RegExp("^([0-9]{4})-([0-9]{1,2})-([0-9]{1,2})(?:(?:t|T|[ \\t]+)([0-9]{1,2}):([0-9]{1,2}):([0-9]{1,2}(\\.[0-9]+)?)(?:[ \\t]*(Z|[-+][012]?[0-9](?::[0-9]{2})?))?)?$"),
      resolve(str) {
        const match = str.match(timestamp.test);
        if (!match)
          throw new Error("!!timestamp expects a date, starting with yyyy-mm-dd");
        const [, year, month, day, hour, minute, second] = match.map(Number);
        const millisec = match[7] ? Number((match[7] + "00").substr(1, 3)) : 0;
        let date = Date.UTC(year, month - 1, day, hour || 0, minute || 0, second || 0, millisec);
        const tz = match[8];
        if (tz && tz !== "Z") {
          let d = parseSexagesimal(tz, false);
          if (Math.abs(d) < 30)
            d *= 60;
          date -= 6e4 * d;
        }
        return new Date(date);
      },
      stringify: ({ value }) => value?.toISOString().replace(/(T00:00:00)?\.000Z$/, "") ?? ""
    };
    exports.floatTime = floatTime;
    exports.intTime = intTime;
    exports.timestamp = timestamp;
  }
});

// node_modules/yaml/dist/schema/yaml-1.1/schema.js
var require_schema3 = __commonJS({
  "node_modules/yaml/dist/schema/yaml-1.1/schema.js"(exports) {
    "use strict";
    var map = require_map();
    var _null = require_null();
    var seq = require_seq();
    var string3 = require_string();
    var binary = require_binary();
    var bool = require_bool2();
    var float = require_float2();
    var int = require_int2();
    var merge = require_merge();
    var omap = require_omap();
    var pairs = require_pairs();
    var set = require_set();
    var timestamp = require_timestamp();
    var schema = [
      map.map,
      seq.seq,
      string3.string,
      _null.nullTag,
      bool.trueTag,
      bool.falseTag,
      int.intBin,
      int.intOct,
      int.int,
      int.intHex,
      float.floatNaN,
      float.floatExp,
      float.float,
      binary.binary,
      merge.merge,
      omap.omap,
      pairs.pairs,
      set.set,
      timestamp.intTime,
      timestamp.floatTime,
      timestamp.timestamp
    ];
    exports.schema = schema;
  }
});

// node_modules/yaml/dist/schema/tags.js
var require_tags = __commonJS({
  "node_modules/yaml/dist/schema/tags.js"(exports) {
    "use strict";
    var map = require_map();
    var _null = require_null();
    var seq = require_seq();
    var string3 = require_string();
    var bool = require_bool();
    var float = require_float();
    var int = require_int();
    var schema = require_schema();
    var schema$1 = require_schema2();
    var binary = require_binary();
    var merge = require_merge();
    var omap = require_omap();
    var pairs = require_pairs();
    var schema$2 = require_schema3();
    var set = require_set();
    var timestamp = require_timestamp();
    var schemas = /* @__PURE__ */ new Map([
      ["core", schema.schema],
      ["failsafe", [map.map, seq.seq, string3.string]],
      ["json", schema$1.schema],
      ["yaml11", schema$2.schema],
      ["yaml-1.1", schema$2.schema]
    ]);
    var tagsByName = {
      binary: binary.binary,
      bool: bool.boolTag,
      float: float.float,
      floatExp: float.floatExp,
      floatNaN: float.floatNaN,
      floatTime: timestamp.floatTime,
      int: int.int,
      intHex: int.intHex,
      intOct: int.intOct,
      intTime: timestamp.intTime,
      map: map.map,
      merge: merge.merge,
      null: _null.nullTag,
      omap: omap.omap,
      pairs: pairs.pairs,
      seq: seq.seq,
      set: set.set,
      timestamp: timestamp.timestamp
    };
    var coreKnownTags = {
      "tag:yaml.org,2002:binary": binary.binary,
      "tag:yaml.org,2002:merge": merge.merge,
      "tag:yaml.org,2002:omap": omap.omap,
      "tag:yaml.org,2002:pairs": pairs.pairs,
      "tag:yaml.org,2002:set": set.set,
      "tag:yaml.org,2002:timestamp": timestamp.timestamp
    };
    function getTags(customTags, schemaName, addMergeTag) {
      const schemaTags = schemas.get(schemaName);
      if (schemaTags && !customTags) {
        return addMergeTag && !schemaTags.includes(merge.merge) ? schemaTags.concat(merge.merge) : schemaTags.slice();
      }
      let tags = schemaTags;
      if (!tags) {
        if (Array.isArray(customTags))
          tags = [];
        else {
          const keys = Array.from(schemas.keys()).filter((key) => key !== "yaml11").map((key) => JSON.stringify(key)).join(", ");
          throw new Error(`Unknown schema "${schemaName}"; use one of ${keys} or define customTags array`);
        }
      }
      if (Array.isArray(customTags)) {
        for (const tag of customTags)
          tags = tags.concat(tag);
      } else if (typeof customTags === "function") {
        tags = customTags(tags.slice());
      }
      if (addMergeTag)
        tags = tags.concat(merge.merge);
      return tags.reduce((tags2, tag) => {
        const tagObj = typeof tag === "string" ? tagsByName[tag] : tag;
        if (!tagObj) {
          const tagName = JSON.stringify(tag);
          const keys = Object.keys(tagsByName).map((key) => JSON.stringify(key)).join(", ");
          throw new Error(`Unknown custom tag ${tagName}; use one of ${keys}`);
        }
        if (!tags2.includes(tagObj))
          tags2.push(tagObj);
        return tags2;
      }, []);
    }
    exports.coreKnownTags = coreKnownTags;
    exports.getTags = getTags;
  }
});

// node_modules/yaml/dist/schema/Schema.js
var require_Schema = __commonJS({
  "node_modules/yaml/dist/schema/Schema.js"(exports) {
    "use strict";
    var identity = require_identity();
    var map = require_map();
    var seq = require_seq();
    var string3 = require_string();
    var tags = require_tags();
    var sortMapEntriesByKey = (a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
    var Schema = class _Schema {
      constructor({ compat, customTags, merge, resolveKnownTags, schema, sortMapEntries, toStringDefaults }) {
        this.compat = Array.isArray(compat) ? tags.getTags(compat, "compat") : compat ? tags.getTags(null, compat) : null;
        this.name = typeof schema === "string" && schema || "core";
        this.knownTags = resolveKnownTags ? tags.coreKnownTags : {};
        this.tags = tags.getTags(customTags, this.name, merge);
        this.toStringOptions = toStringDefaults ?? null;
        Object.defineProperty(this, identity.MAP, { value: map.map });
        Object.defineProperty(this, identity.SCALAR, { value: string3.string });
        Object.defineProperty(this, identity.SEQ, { value: seq.seq });
        this.sortMapEntries = typeof sortMapEntries === "function" ? sortMapEntries : sortMapEntries === true ? sortMapEntriesByKey : null;
      }
      clone() {
        const copy = Object.create(_Schema.prototype, Object.getOwnPropertyDescriptors(this));
        copy.tags = this.tags.slice();
        return copy;
      }
    };
    exports.Schema = Schema;
  }
});

// node_modules/yaml/dist/stringify/stringifyDocument.js
var require_stringifyDocument = __commonJS({
  "node_modules/yaml/dist/stringify/stringifyDocument.js"(exports) {
    "use strict";
    var identity = require_identity();
    var stringify2 = require_stringify();
    var stringifyComment = require_stringifyComment();
    function stringifyDocument(doc, options) {
      const lines2 = [];
      let hasDirectives = options.directives === true;
      if (options.directives !== false && doc.directives) {
        const dir = doc.directives.toString(doc);
        if (dir) {
          lines2.push(dir);
          hasDirectives = true;
        } else if (doc.directives.docStart)
          hasDirectives = true;
      }
      if (hasDirectives)
        lines2.push("---");
      const ctx = stringify2.createStringifyContext(doc, options);
      const { commentString } = ctx.options;
      if (doc.commentBefore) {
        if (lines2.length !== 1)
          lines2.unshift("");
        const cs = commentString(doc.commentBefore);
        lines2.unshift(stringifyComment.indentComment(cs, ""));
      }
      let chompKeep = false;
      let contentComment = null;
      if (doc.contents) {
        if (identity.isNode(doc.contents)) {
          if (doc.contents.spaceBefore && hasDirectives)
            lines2.push("");
          if (doc.contents.commentBefore) {
            const cs = commentString(doc.contents.commentBefore);
            lines2.push(stringifyComment.indentComment(cs, ""));
          }
          ctx.forceBlockIndent = !!doc.comment;
          contentComment = doc.contents.comment;
        }
        const onChompKeep = contentComment ? void 0 : () => chompKeep = true;
        let body2 = stringify2.stringify(doc.contents, ctx, () => contentComment = null, onChompKeep);
        if (contentComment)
          body2 += stringifyComment.lineComment(body2, "", commentString(contentComment));
        if ((body2[0] === "|" || body2[0] === ">") && lines2[lines2.length - 1] === "---") {
          lines2[lines2.length - 1] = `--- ${body2}`;
        } else
          lines2.push(body2);
      } else {
        lines2.push(stringify2.stringify(doc.contents, ctx));
      }
      if (doc.directives?.docEnd) {
        if (doc.comment) {
          const cs = commentString(doc.comment);
          if (cs.includes("\n")) {
            lines2.push("...");
            lines2.push(stringifyComment.indentComment(cs, ""));
          } else {
            lines2.push(`... ${cs}`);
          }
        } else {
          lines2.push("...");
        }
      } else {
        let dc = doc.comment;
        if (dc && chompKeep)
          dc = dc.replace(/^\n+/, "");
        if (dc) {
          if ((!chompKeep || contentComment) && lines2[lines2.length - 1] !== "")
            lines2.push("");
          lines2.push(stringifyComment.indentComment(commentString(dc), ""));
        }
      }
      return lines2.join("\n") + "\n";
    }
    exports.stringifyDocument = stringifyDocument;
  }
});

// node_modules/yaml/dist/doc/Document.js
var require_Document = __commonJS({
  "node_modules/yaml/dist/doc/Document.js"(exports) {
    "use strict";
    var Alias = require_Alias();
    var Collection = require_Collection();
    var identity = require_identity();
    var Pair = require_Pair();
    var toJS = require_toJS();
    var Schema = require_Schema();
    var stringifyDocument = require_stringifyDocument();
    var anchors = require_anchors();
    var applyReviver = require_applyReviver();
    var createNode = require_createNode();
    var directives = require_directives();
    var Document = class _Document {
      constructor(value, replacer, options) {
        this.commentBefore = null;
        this.comment = null;
        this.errors = [];
        this.warnings = [];
        Object.defineProperty(this, identity.NODE_TYPE, { value: identity.DOC });
        let _replacer = null;
        if (typeof replacer === "function" || Array.isArray(replacer)) {
          _replacer = replacer;
        } else if (options === void 0 && replacer) {
          options = replacer;
          replacer = void 0;
        }
        const opt = Object.assign({
          intAsBigInt: false,
          keepSourceTokens: false,
          logLevel: "warn",
          prettyErrors: true,
          strict: true,
          stringKeys: false,
          uniqueKeys: true,
          version: "1.2"
        }, options);
        this.options = opt;
        let { version } = opt;
        if (options?._directives) {
          this.directives = options._directives.atDocument();
          if (this.directives.yaml.explicit)
            version = this.directives.yaml.version;
        } else
          this.directives = new directives.Directives({ version });
        this.setSchema(version, options);
        this.contents = value === void 0 ? null : this.createNode(value, _replacer, options);
      }
      /**
       * Create a deep copy of this Document and its contents.
       *
       * Custom Node values that inherit from `Object` still refer to their original instances.
       */
      clone() {
        const copy = Object.create(_Document.prototype, {
          [identity.NODE_TYPE]: { value: identity.DOC }
        });
        copy.commentBefore = this.commentBefore;
        copy.comment = this.comment;
        copy.errors = this.errors.slice();
        copy.warnings = this.warnings.slice();
        copy.options = Object.assign({}, this.options);
        if (this.directives)
          copy.directives = this.directives.clone();
        copy.schema = this.schema.clone();
        copy.contents = identity.isNode(this.contents) ? this.contents.clone(copy.schema) : this.contents;
        if (this.range)
          copy.range = this.range.slice();
        return copy;
      }
      /** Adds a value to the document. */
      add(value) {
        if (assertCollection(this.contents))
          this.contents.add(value);
      }
      /** Adds a value to the document. */
      addIn(path2, value) {
        if (assertCollection(this.contents))
          this.contents.addIn(path2, value);
      }
      /**
       * Create a new `Alias` node, ensuring that the target `node` has the required anchor.
       *
       * If `node` already has an anchor, `name` is ignored.
       * Otherwise, the `node.anchor` value will be set to `name`,
       * or if an anchor with that name is already present in the document,
       * `name` will be used as a prefix for a new unique anchor.
       * If `name` is undefined, the generated anchor will use 'a' as a prefix.
       */
      createAlias(node2, name) {
        if (!node2.anchor) {
          const prev = anchors.anchorNames(this);
          node2.anchor = // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing
          !name || prev.has(name) ? anchors.findNewAnchor(name || "a", prev) : name;
        }
        return new Alias.Alias(node2.anchor);
      }
      createNode(value, replacer, options) {
        let _replacer = void 0;
        if (typeof replacer === "function") {
          value = replacer.call({ "": value }, "", value);
          _replacer = replacer;
        } else if (Array.isArray(replacer)) {
          const keyToStr = (v) => typeof v === "number" || v instanceof String || v instanceof Number;
          const asStr = replacer.filter(keyToStr).map(String);
          if (asStr.length > 0)
            replacer = replacer.concat(asStr);
          _replacer = replacer;
        } else if (options === void 0 && replacer) {
          options = replacer;
          replacer = void 0;
        }
        const { aliasDuplicateObjects, anchorPrefix, flow: flow3, keepUndefined, onTagObj, tag } = options ?? {};
        const { onAnchor, setAnchors, sourceObjects } = anchors.createNodeAnchors(
          this,
          // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing
          anchorPrefix || "a"
        );
        const ctx = {
          aliasDuplicateObjects: aliasDuplicateObjects ?? true,
          keepUndefined: keepUndefined ?? false,
          onAnchor,
          onTagObj,
          replacer: _replacer,
          schema: this.schema,
          sourceObjects
        };
        const node2 = createNode.createNode(value, tag, ctx);
        if (flow3 && identity.isCollection(node2))
          node2.flow = true;
        setAnchors();
        return node2;
      }
      /**
       * Convert a key and a value into a `Pair` using the current schema,
       * recursively wrapping all values as `Scalar` or `Collection` nodes.
       */
      createPair(key, value, options = {}) {
        const k = this.createNode(key, null, options);
        const v = this.createNode(value, null, options);
        return new Pair.Pair(k, v);
      }
      /**
       * Removes a value from the document.
       * @returns `true` if the item was found and removed.
       */
      delete(key) {
        return assertCollection(this.contents) ? this.contents.delete(key) : false;
      }
      /**
       * Removes a value from the document.
       * @returns `true` if the item was found and removed.
       */
      deleteIn(path2) {
        if (Collection.isEmptyPath(path2)) {
          if (this.contents == null)
            return false;
          this.contents = null;
          return true;
        }
        return assertCollection(this.contents) ? this.contents.deleteIn(path2) : false;
      }
      /**
       * Returns item at `key`, or `undefined` if not found. By default unwraps
       * scalar values from their surrounding node; to disable set `keepScalar` to
       * `true` (collections are always returned intact).
       */
      get(key, keepScalar) {
        return identity.isCollection(this.contents) ? this.contents.get(key, keepScalar) : void 0;
      }
      /**
       * Returns item at `path`, or `undefined` if not found. By default unwraps
       * scalar values from their surrounding node; to disable set `keepScalar` to
       * `true` (collections are always returned intact).
       */
      getIn(path2, keepScalar) {
        if (Collection.isEmptyPath(path2))
          return !keepScalar && identity.isScalar(this.contents) ? this.contents.value : this.contents;
        return identity.isCollection(this.contents) ? this.contents.getIn(path2, keepScalar) : void 0;
      }
      /**
       * Checks if the document includes a value with the key `key`.
       */
      has(key) {
        return identity.isCollection(this.contents) ? this.contents.has(key) : false;
      }
      /**
       * Checks if the document includes a value at `path`.
       */
      hasIn(path2) {
        if (Collection.isEmptyPath(path2))
          return this.contents !== void 0;
        return identity.isCollection(this.contents) ? this.contents.hasIn(path2) : false;
      }
      /**
       * Sets a value in this document. For `!!set`, `value` needs to be a
       * boolean to add/remove the item from the set.
       */
      set(key, value) {
        if (this.contents == null) {
          this.contents = Collection.collectionFromPath(this.schema, [key], value);
        } else if (assertCollection(this.contents)) {
          this.contents.set(key, value);
        }
      }
      /**
       * Sets a value in this document. For `!!set`, `value` needs to be a
       * boolean to add/remove the item from the set.
       */
      setIn(path2, value) {
        if (Collection.isEmptyPath(path2)) {
          this.contents = value;
        } else if (this.contents == null) {
          this.contents = Collection.collectionFromPath(this.schema, Array.from(path2), value);
        } else if (assertCollection(this.contents)) {
          this.contents.setIn(path2, value);
        }
      }
      /**
       * Change the YAML version and schema used by the document.
       * A `null` version disables support for directives, explicit tags, anchors, and aliases.
       * It also requires the `schema` option to be given as a `Schema` instance value.
       *
       * Overrides all previously set schema options.
       */
      setSchema(version, options = {}) {
        if (typeof version === "number")
          version = String(version);
        let opt;
        switch (version) {
          case "1.1":
            if (this.directives)
              this.directives.yaml.version = "1.1";
            else
              this.directives = new directives.Directives({ version: "1.1" });
            opt = { resolveKnownTags: false, schema: "yaml-1.1" };
            break;
          case "1.2":
          case "next":
            if (this.directives)
              this.directives.yaml.version = version;
            else
              this.directives = new directives.Directives({ version });
            opt = { resolveKnownTags: true, schema: "core" };
            break;
          case null:
            if (this.directives)
              delete this.directives;
            opt = null;
            break;
          default: {
            const sv = JSON.stringify(version);
            throw new Error(`Expected '1.1', '1.2' or null as first argument, but found: ${sv}`);
          }
        }
        if (options.schema instanceof Object)
          this.schema = options.schema;
        else if (opt)
          this.schema = new Schema.Schema(Object.assign(opt, options));
        else
          throw new Error(`With a null YAML version, the { schema: Schema } option is required`);
      }
      // json & jsonArg are only used from toJSON()
      toJS({ json, jsonArg, mapAsMap, maxAliasCount, onAnchor, reviver } = {}) {
        const ctx = {
          anchors: /* @__PURE__ */ new Map(),
          doc: this,
          keep: !json,
          mapAsMap: mapAsMap === true,
          mapKeyWarned: false,
          maxAliasCount: typeof maxAliasCount === "number" ? maxAliasCount : 100
        };
        const res = toJS.toJS(this.contents, jsonArg ?? "", ctx);
        if (typeof onAnchor === "function")
          for (const { count: count4, res: res2 } of ctx.anchors.values())
            onAnchor(res2, count4);
        return typeof reviver === "function" ? applyReviver.applyReviver(reviver, { "": res }, "", res) : res;
      }
      /**
       * A JSON representation of the document `contents`.
       *
       * @param jsonArg Used by `JSON.stringify` to indicate the array index or
       *   property name.
       */
      toJSON(jsonArg, onAnchor) {
        return this.toJS({ json: true, jsonArg, mapAsMap: false, onAnchor });
      }
      /** A YAML representation of the document. */
      toString(options = {}) {
        if (this.errors.length > 0)
          throw new Error("Document with errors cannot be stringified");
        if ("indent" in options && (!Number.isInteger(options.indent) || Number(options.indent) <= 0)) {
          const s = JSON.stringify(options.indent);
          throw new Error(`"indent" option must be a positive integer, not ${s}`);
        }
        return stringifyDocument.stringifyDocument(this, options);
      }
    };
    function assertCollection(contents) {
      if (identity.isCollection(contents))
        return true;
      throw new Error("Expected a YAML collection as document contents");
    }
    exports.Document = Document;
  }
});

// node_modules/yaml/dist/errors.js
var require_errors = __commonJS({
  "node_modules/yaml/dist/errors.js"(exports) {
    "use strict";
    var YAMLError = class extends Error {
      constructor(name, pos, code2, message) {
        super();
        this.name = name;
        this.code = code2;
        this.message = message;
        this.pos = pos;
      }
    };
    var YAMLParseError = class extends YAMLError {
      constructor(pos, code2, message) {
        super("YAMLParseError", pos, code2, message);
      }
    };
    var YAMLWarning = class extends YAMLError {
      constructor(pos, code2, message) {
        super("YAMLWarning", pos, code2, message);
      }
    };
    var prettifyError = (src, lc) => (error) => {
      if (error.pos[0] === -1)
        return;
      error.linePos = error.pos.map((pos) => lc.linePos(pos));
      const { line: line2, col } = error.linePos[0];
      error.message += ` at line ${line2}, column ${col}`;
      let ci = col - 1;
      let lineStr = src.substring(lc.lineStarts[line2 - 1], lc.lineStarts[line2]).replace(/[\n\r]+$/, "");
      if (ci >= 60 && lineStr.length > 80) {
        const trimStart = Math.min(ci - 39, lineStr.length - 79);
        lineStr = "\u2026" + lineStr.substring(trimStart);
        ci -= trimStart - 1;
      }
      if (lineStr.length > 80)
        lineStr = lineStr.substring(0, 79) + "\u2026";
      if (line2 > 1 && /^ *$/.test(lineStr.substring(0, ci))) {
        let prev = src.substring(lc.lineStarts[line2 - 2], lc.lineStarts[line2 - 1]);
        if (prev.length > 80)
          prev = prev.substring(0, 79) + "\u2026\n";
        lineStr = prev + lineStr;
      }
      if (/[^ ]/.test(lineStr)) {
        let count4 = 1;
        const end2 = error.linePos[1];
        if (end2?.line === line2 && end2.col > col) {
          count4 = Math.max(1, Math.min(end2.col - col, 80 - ci));
        }
        const pointer = " ".repeat(ci) + "^".repeat(count4);
        error.message += `:

${lineStr}
${pointer}
`;
      }
    };
    exports.YAMLError = YAMLError;
    exports.YAMLParseError = YAMLParseError;
    exports.YAMLWarning = YAMLWarning;
    exports.prettifyError = prettifyError;
  }
});

// node_modules/yaml/dist/compose/resolve-props.js
var require_resolve_props = __commonJS({
  "node_modules/yaml/dist/compose/resolve-props.js"(exports) {
    "use strict";
    function resolveProps(tokens, { flow: flow3, indicator, next, offset, onError, parentIndent, startOnNewline }) {
      let spaceBefore = false;
      let atNewline = startOnNewline;
      let hasSpace = startOnNewline;
      let comment = "";
      let commentSep = "";
      let hasNewline = false;
      let reqSpace = false;
      let tab = null;
      let anchor = null;
      let tag = null;
      let newlineAfterProp = null;
      let comma = null;
      let found = null;
      let start2 = null;
      for (const token of tokens) {
        if (reqSpace) {
          if (token.type !== "space" && token.type !== "newline" && token.type !== "comma")
            onError(token.offset, "MISSING_CHAR", "Tags and anchors must be separated from the next token by white space");
          reqSpace = false;
        }
        if (tab) {
          if (atNewline && token.type !== "comment" && token.type !== "newline") {
            onError(tab, "TAB_AS_INDENT", "Tabs are not allowed as indentation");
          }
          tab = null;
        }
        switch (token.type) {
          case "space":
            if (!flow3 && (indicator !== "doc-start" || next?.type !== "flow-collection") && token.source.includes("	")) {
              tab = token;
            }
            hasSpace = true;
            break;
          case "comment": {
            if (!hasSpace)
              onError(token, "MISSING_CHAR", "Comments must be separated from other tokens by white space characters");
            const cb = token.source.substring(1) || " ";
            if (!comment)
              comment = cb;
            else
              comment += commentSep + cb;
            commentSep = "";
            atNewline = false;
            break;
          }
          case "newline":
            if (atNewline) {
              if (comment)
                comment += token.source;
              else if (!found || indicator !== "seq-item-ind")
                spaceBefore = true;
            } else
              commentSep += token.source;
            atNewline = true;
            hasNewline = true;
            if (anchor || tag)
              newlineAfterProp = token;
            hasSpace = true;
            break;
          case "anchor":
            if (anchor)
              onError(token, "MULTIPLE_ANCHORS", "A node can have at most one anchor");
            if (token.source.endsWith(":"))
              onError(token.offset + token.source.length - 1, "BAD_ALIAS", "Anchor ending in : is ambiguous", true);
            anchor = token;
            start2 ?? (start2 = token.offset);
            atNewline = false;
            hasSpace = false;
            reqSpace = true;
            break;
          case "tag": {
            if (tag)
              onError(token, "MULTIPLE_TAGS", "A node can have at most one tag");
            tag = token;
            start2 ?? (start2 = token.offset);
            atNewline = false;
            hasSpace = false;
            reqSpace = true;
            break;
          }
          case indicator:
            if (anchor || tag)
              onError(token, "BAD_PROP_ORDER", `Anchors and tags must be after the ${token.source} indicator`);
            if (found)
              onError(token, "UNEXPECTED_TOKEN", `Unexpected ${token.source} in ${flow3 ?? "collection"}`);
            found = token;
            atNewline = indicator === "seq-item-ind" || indicator === "explicit-key-ind";
            hasSpace = false;
            break;
          case "comma":
            if (flow3) {
              if (comma)
                onError(token, "UNEXPECTED_TOKEN", `Unexpected , in ${flow3}`);
              comma = token;
              atNewline = false;
              hasSpace = false;
              break;
            }
          // else fallthrough
          default:
            onError(token, "UNEXPECTED_TOKEN", `Unexpected ${token.type} token`);
            atNewline = false;
            hasSpace = false;
        }
      }
      const last = tokens[tokens.length - 1];
      const end2 = last ? last.offset + last.source.length : offset;
      if (reqSpace && next && next.type !== "space" && next.type !== "newline" && next.type !== "comma" && (next.type !== "scalar" || next.source !== "")) {
        onError(next.offset, "MISSING_CHAR", "Tags and anchors must be separated from the next token by white space");
      }
      if (tab && (atNewline && tab.indent <= parentIndent || next?.type === "block-map" || next?.type === "block-seq"))
        onError(tab, "TAB_AS_INDENT", "Tabs are not allowed as indentation");
      return {
        comma,
        found,
        spaceBefore,
        comment,
        hasNewline,
        anchor,
        tag,
        newlineAfterProp,
        end: end2,
        start: start2 ?? end2
      };
    }
    exports.resolveProps = resolveProps;
  }
});

// node_modules/yaml/dist/compose/util-contains-newline.js
var require_util_contains_newline = __commonJS({
  "node_modules/yaml/dist/compose/util-contains-newline.js"(exports) {
    "use strict";
    function containsNewline(key) {
      if (!key)
        return null;
      switch (key.type) {
        case "alias":
        case "scalar":
        case "double-quoted-scalar":
        case "single-quoted-scalar":
          if (key.source.includes("\n"))
            return true;
          if (key.end) {
            for (const st of key.end)
              if (st.type === "newline")
                return true;
          }
          return false;
        case "flow-collection":
          for (const it of key.items) {
            for (const st of it.start)
              if (st.type === "newline")
                return true;
            if (it.sep) {
              for (const st of it.sep)
                if (st.type === "newline")
                  return true;
            }
            if (containsNewline(it.key) || containsNewline(it.value))
              return true;
          }
          return false;
        default:
          return true;
      }
    }
    exports.containsNewline = containsNewline;
  }
});

// node_modules/yaml/dist/compose/util-flow-indent-check.js
var require_util_flow_indent_check = __commonJS({
  "node_modules/yaml/dist/compose/util-flow-indent-check.js"(exports) {
    "use strict";
    var utilContainsNewline = require_util_contains_newline();
    function flowIndentCheck(indent2, fc, onError) {
      if (fc?.type === "flow-collection") {
        const end2 = fc.end[0];
        if (end2.indent === indent2 && (end2.source === "]" || end2.source === "}") && utilContainsNewline.containsNewline(fc)) {
          const msg = "Flow end indicator should be more indented than parent";
          onError(end2, "BAD_INDENT", msg, true);
        }
      }
    }
    exports.flowIndentCheck = flowIndentCheck;
  }
});

// node_modules/yaml/dist/compose/util-map-includes.js
var require_util_map_includes = __commonJS({
  "node_modules/yaml/dist/compose/util-map-includes.js"(exports) {
    "use strict";
    var identity = require_identity();
    function mapIncludes(ctx, items, search2) {
      const { uniqueKeys } = ctx.options;
      if (uniqueKeys === false)
        return false;
      const isEqual = typeof uniqueKeys === "function" ? uniqueKeys : (a, b) => a === b || identity.isScalar(a) && identity.isScalar(b) && a.value === b.value;
      return items.some((pair) => isEqual(pair.key, search2));
    }
    exports.mapIncludes = mapIncludes;
  }
});

// node_modules/yaml/dist/compose/resolve-block-map.js
var require_resolve_block_map = __commonJS({
  "node_modules/yaml/dist/compose/resolve-block-map.js"(exports) {
    "use strict";
    var Pair = require_Pair();
    var YAMLMap = require_YAMLMap();
    var resolveProps = require_resolve_props();
    var utilContainsNewline = require_util_contains_newline();
    var utilFlowIndentCheck = require_util_flow_indent_check();
    var utilMapIncludes = require_util_map_includes();
    var startColMsg = "All mapping items must start at the same column";
    function resolveBlockMap({ composeNode, composeEmptyNode }, ctx, bm, onError, tag) {
      const NodeClass = tag?.nodeClass ?? YAMLMap.YAMLMap;
      const map = new NodeClass(ctx.schema);
      if (ctx.atRoot)
        ctx.atRoot = false;
      let offset = bm.offset;
      let commentEnd = null;
      for (const collItem of bm.items) {
        const { start: start2, key, sep: sep3, value } = collItem;
        const keyProps = resolveProps.resolveProps(start2, {
          indicator: "explicit-key-ind",
          next: key ?? sep3?.[0],
          offset,
          onError,
          parentIndent: bm.indent,
          startOnNewline: true
        });
        const implicitKey = !keyProps.found;
        if (implicitKey) {
          if (key) {
            if (key.type === "block-seq")
              onError(offset, "BLOCK_AS_IMPLICIT_KEY", "A block sequence may not be used as an implicit map key");
            else if ("indent" in key && key.indent !== bm.indent)
              onError(offset, "BAD_INDENT", startColMsg);
          }
          if (!keyProps.anchor && !keyProps.tag && !sep3) {
            commentEnd = keyProps.end;
            if (keyProps.comment) {
              if (map.comment)
                map.comment += "\n" + keyProps.comment;
              else
                map.comment = keyProps.comment;
            }
            continue;
          }
          if (keyProps.newlineAfterProp || utilContainsNewline.containsNewline(key)) {
            onError(key ?? start2[start2.length - 1], "MULTILINE_IMPLICIT_KEY", "Implicit keys need to be on a single line");
          }
        } else if (keyProps.found?.indent !== bm.indent) {
          onError(offset, "BAD_INDENT", startColMsg);
        }
        ctx.atKey = true;
        const keyStart = keyProps.end;
        const keyNode = key ? composeNode(ctx, key, keyProps, onError) : composeEmptyNode(ctx, keyStart, start2, null, keyProps, onError);
        if (ctx.schema.compat)
          utilFlowIndentCheck.flowIndentCheck(bm.indent, key, onError);
        ctx.atKey = false;
        if (utilMapIncludes.mapIncludes(ctx, map.items, keyNode))
          onError(keyStart, "DUPLICATE_KEY", "Map keys must be unique");
        const valueProps = resolveProps.resolveProps(sep3 ?? [], {
          indicator: "map-value-ind",
          next: value,
          offset: keyNode.range[2],
          onError,
          parentIndent: bm.indent,
          startOnNewline: !key || key.type === "block-scalar"
        });
        offset = valueProps.end;
        if (valueProps.found) {
          if (implicitKey) {
            if (value?.type === "block-map" && !valueProps.hasNewline)
              onError(offset, "BLOCK_AS_IMPLICIT_KEY", "Nested mappings are not allowed in compact mappings");
            if (ctx.options.strict && keyProps.start < valueProps.found.offset - 1024)
              onError(keyNode.range, "KEY_OVER_1024_CHARS", "The : indicator must be at most 1024 chars after the start of an implicit block mapping key");
          }
          const valueNode = value ? composeNode(ctx, value, valueProps, onError) : composeEmptyNode(ctx, offset, sep3, null, valueProps, onError);
          if (ctx.schema.compat)
            utilFlowIndentCheck.flowIndentCheck(bm.indent, value, onError);
          offset = valueNode.range[2];
          const pair = new Pair.Pair(keyNode, valueNode);
          if (ctx.options.keepSourceTokens)
            pair.srcToken = collItem;
          map.items.push(pair);
        } else {
          if (implicitKey)
            onError(keyNode.range, "MISSING_CHAR", "Implicit map keys need to be followed by map values");
          if (valueProps.comment) {
            if (keyNode.comment)
              keyNode.comment += "\n" + valueProps.comment;
            else
              keyNode.comment = valueProps.comment;
          }
          const pair = new Pair.Pair(keyNode);
          if (ctx.options.keepSourceTokens)
            pair.srcToken = collItem;
          map.items.push(pair);
        }
      }
      if (commentEnd && commentEnd < offset)
        onError(commentEnd, "IMPOSSIBLE", "Map comment with trailing content");
      map.range = [bm.offset, offset, commentEnd ?? offset];
      return map;
    }
    exports.resolveBlockMap = resolveBlockMap;
  }
});

// node_modules/yaml/dist/compose/resolve-block-seq.js
var require_resolve_block_seq = __commonJS({
  "node_modules/yaml/dist/compose/resolve-block-seq.js"(exports) {
    "use strict";
    var YAMLSeq = require_YAMLSeq();
    var resolveProps = require_resolve_props();
    var utilFlowIndentCheck = require_util_flow_indent_check();
    function resolveBlockSeq({ composeNode, composeEmptyNode }, ctx, bs, onError, tag) {
      const NodeClass = tag?.nodeClass ?? YAMLSeq.YAMLSeq;
      const seq = new NodeClass(ctx.schema);
      if (ctx.atRoot)
        ctx.atRoot = false;
      if (ctx.atKey)
        ctx.atKey = false;
      let offset = bs.offset;
      let commentEnd = null;
      for (const { start: start2, value } of bs.items) {
        const props = resolveProps.resolveProps(start2, {
          indicator: "seq-item-ind",
          next: value,
          offset,
          onError,
          parentIndent: bs.indent,
          startOnNewline: true
        });
        if (!props.found) {
          if (props.anchor || props.tag || value) {
            if (value?.type === "block-seq")
              onError(props.end, "BAD_INDENT", "All sequence items must start at the same column");
            else
              onError(offset, "MISSING_CHAR", "Sequence item without - indicator");
          } else {
            commentEnd = props.end;
            if (props.comment)
              seq.comment = props.comment;
            continue;
          }
        }
        const node2 = value ? composeNode(ctx, value, props, onError) : composeEmptyNode(ctx, props.end, start2, null, props, onError);
        if (ctx.schema.compat)
          utilFlowIndentCheck.flowIndentCheck(bs.indent, value, onError);
        offset = node2.range[2];
        seq.items.push(node2);
      }
      seq.range = [bs.offset, offset, commentEnd ?? offset];
      return seq;
    }
    exports.resolveBlockSeq = resolveBlockSeq;
  }
});

// node_modules/yaml/dist/compose/resolve-end.js
var require_resolve_end = __commonJS({
  "node_modules/yaml/dist/compose/resolve-end.js"(exports) {
    "use strict";
    function resolveEnd(end2, offset, reqSpace, onError) {
      let comment = "";
      if (end2) {
        let hasSpace = false;
        let sep3 = "";
        for (const token of end2) {
          const { source, type } = token;
          switch (type) {
            case "space":
              hasSpace = true;
              break;
            case "comment": {
              if (reqSpace && !hasSpace)
                onError(token, "MISSING_CHAR", "Comments must be separated from other tokens by white space characters");
              const cb = source.substring(1) || " ";
              if (!comment)
                comment = cb;
              else
                comment += sep3 + cb;
              sep3 = "";
              break;
            }
            case "newline":
              if (comment)
                sep3 += source;
              hasSpace = true;
              break;
            default:
              onError(token, "UNEXPECTED_TOKEN", `Unexpected ${type} at node end`);
          }
          offset += source.length;
        }
      }
      return { comment, offset };
    }
    exports.resolveEnd = resolveEnd;
  }
});

// node_modules/yaml/dist/compose/resolve-flow-collection.js
var require_resolve_flow_collection = __commonJS({
  "node_modules/yaml/dist/compose/resolve-flow-collection.js"(exports) {
    "use strict";
    var identity = require_identity();
    var Pair = require_Pair();
    var YAMLMap = require_YAMLMap();
    var YAMLSeq = require_YAMLSeq();
    var resolveEnd = require_resolve_end();
    var resolveProps = require_resolve_props();
    var utilContainsNewline = require_util_contains_newline();
    var utilMapIncludes = require_util_map_includes();
    var blockMsg = "Block collections are not allowed within flow collections";
    var isBlock = (token) => token && (token.type === "block-map" || token.type === "block-seq");
    function resolveFlowCollection({ composeNode, composeEmptyNode }, ctx, fc, onError, tag) {
      const isMap3 = fc.start.source === "{";
      const fcName = isMap3 ? "flow map" : "flow sequence";
      const NodeClass = tag?.nodeClass ?? (isMap3 ? YAMLMap.YAMLMap : YAMLSeq.YAMLSeq);
      const coll = new NodeClass(ctx.schema);
      coll.flow = true;
      const atRoot = ctx.atRoot;
      if (atRoot)
        ctx.atRoot = false;
      if (ctx.atKey)
        ctx.atKey = false;
      let offset = fc.offset + fc.start.source.length;
      for (let i = 0; i < fc.items.length; ++i) {
        const collItem = fc.items[i];
        const { start: start2, key, sep: sep3, value } = collItem;
        const props = resolveProps.resolveProps(start2, {
          flow: fcName,
          indicator: "explicit-key-ind",
          next: key ?? sep3?.[0],
          offset,
          onError,
          parentIndent: fc.indent,
          startOnNewline: false
        });
        if (!props.found) {
          if (!props.anchor && !props.tag && !sep3 && !value) {
            if (i === 0 && props.comma)
              onError(props.comma, "UNEXPECTED_TOKEN", `Unexpected , in ${fcName}`);
            else if (i < fc.items.length - 1)
              onError(props.start, "UNEXPECTED_TOKEN", `Unexpected empty item in ${fcName}`);
            if (props.comment) {
              if (coll.comment)
                coll.comment += "\n" + props.comment;
              else
                coll.comment = props.comment;
            }
            offset = props.end;
            continue;
          }
          if (!isMap3 && ctx.options.strict && utilContainsNewline.containsNewline(key))
            onError(
              key,
              // checked by containsNewline()
              "MULTILINE_IMPLICIT_KEY",
              "Implicit keys of flow sequence pairs need to be on a single line"
            );
        }
        if (i === 0) {
          if (props.comma)
            onError(props.comma, "UNEXPECTED_TOKEN", `Unexpected , in ${fcName}`);
        } else {
          if (!props.comma)
            onError(props.start, "MISSING_CHAR", `Missing , between ${fcName} items`);
          if (props.comment) {
            let prevItemComment = "";
            loop: for (const st of start2) {
              switch (st.type) {
                case "comma":
                case "space":
                  break;
                case "comment":
                  prevItemComment = st.source.substring(1);
                  break loop;
                default:
                  break loop;
              }
            }
            if (prevItemComment) {
              let prev = coll.items[coll.items.length - 1];
              if (identity.isPair(prev))
                prev = prev.value ?? prev.key;
              if (prev.comment)
                prev.comment += "\n" + prevItemComment;
              else
                prev.comment = prevItemComment;
              props.comment = props.comment.substring(prevItemComment.length + 1);
            }
          }
        }
        if (!isMap3 && !sep3 && !props.found) {
          const valueNode = value ? composeNode(ctx, value, props, onError) : composeEmptyNode(ctx, props.end, sep3, null, props, onError);
          coll.items.push(valueNode);
          offset = valueNode.range[2];
          if (isBlock(value))
            onError(valueNode.range, "BLOCK_IN_FLOW", blockMsg);
        } else {
          ctx.atKey = true;
          const keyStart = props.end;
          const keyNode = key ? composeNode(ctx, key, props, onError) : composeEmptyNode(ctx, keyStart, start2, null, props, onError);
          if (isBlock(key))
            onError(keyNode.range, "BLOCK_IN_FLOW", blockMsg);
          ctx.atKey = false;
          const valueProps = resolveProps.resolveProps(sep3 ?? [], {
            flow: fcName,
            indicator: "map-value-ind",
            next: value,
            offset: keyNode.range[2],
            onError,
            parentIndent: fc.indent,
            startOnNewline: false
          });
          if (valueProps.found) {
            if (!isMap3 && !props.found && ctx.options.strict) {
              if (sep3)
                for (const st of sep3) {
                  if (st === valueProps.found)
                    break;
                  if (st.type === "newline") {
                    onError(st, "MULTILINE_IMPLICIT_KEY", "Implicit keys of flow sequence pairs need to be on a single line");
                    break;
                  }
                }
              if (props.start < valueProps.found.offset - 1024)
                onError(valueProps.found, "KEY_OVER_1024_CHARS", "The : indicator must be at most 1024 chars after the start of an implicit flow sequence key");
            }
          } else if (value) {
            if ("source" in value && value.source?.[0] === ":")
              onError(value, "MISSING_CHAR", `Missing space after : in ${fcName}`);
            else
              onError(valueProps.start, "MISSING_CHAR", `Missing , or : between ${fcName} items`);
          }
          const valueNode = value ? composeNode(ctx, value, valueProps, onError) : valueProps.found ? composeEmptyNode(ctx, valueProps.end, sep3, null, valueProps, onError) : null;
          if (valueNode) {
            if (isBlock(value))
              onError(valueNode.range, "BLOCK_IN_FLOW", blockMsg);
          } else if (valueProps.comment) {
            if (keyNode.comment)
              keyNode.comment += "\n" + valueProps.comment;
            else
              keyNode.comment = valueProps.comment;
          }
          const pair = new Pair.Pair(keyNode, valueNode);
          if (ctx.options.keepSourceTokens)
            pair.srcToken = collItem;
          if (isMap3) {
            const map = coll;
            if (utilMapIncludes.mapIncludes(ctx, map.items, keyNode))
              onError(keyStart, "DUPLICATE_KEY", "Map keys must be unique");
            map.items.push(pair);
          } else {
            const map = new YAMLMap.YAMLMap(ctx.schema);
            map.flow = true;
            map.items.push(pair);
            const endRange = (valueNode ?? keyNode).range;
            map.range = [keyNode.range[0], endRange[1], endRange[2]];
            coll.items.push(map);
          }
          offset = valueNode ? valueNode.range[2] : valueProps.end;
        }
      }
      const expectedEnd = isMap3 ? "}" : "]";
      const [ce, ...ee] = fc.end;
      let cePos = offset;
      if (ce?.source === expectedEnd)
        cePos = ce.offset + ce.source.length;
      else {
        const name = fcName[0].toUpperCase() + fcName.substring(1);
        const msg = atRoot ? `${name} must end with a ${expectedEnd}` : `${name} in block collection must be sufficiently indented and end with a ${expectedEnd}`;
        onError(offset, atRoot ? "MISSING_CHAR" : "BAD_INDENT", msg);
        if (ce && ce.source.length !== 1)
          ee.unshift(ce);
      }
      if (ee.length > 0) {
        const end2 = resolveEnd.resolveEnd(ee, cePos, ctx.options.strict, onError);
        if (end2.comment) {
          if (coll.comment)
            coll.comment += "\n" + end2.comment;
          else
            coll.comment = end2.comment;
        }
        coll.range = [fc.offset, cePos, end2.offset];
      } else {
        coll.range = [fc.offset, cePos, cePos];
      }
      return coll;
    }
    exports.resolveFlowCollection = resolveFlowCollection;
  }
});

// node_modules/yaml/dist/compose/compose-collection.js
var require_compose_collection = __commonJS({
  "node_modules/yaml/dist/compose/compose-collection.js"(exports) {
    "use strict";
    var identity = require_identity();
    var Scalar = require_Scalar();
    var YAMLMap = require_YAMLMap();
    var YAMLSeq = require_YAMLSeq();
    var resolveBlockMap = require_resolve_block_map();
    var resolveBlockSeq = require_resolve_block_seq();
    var resolveFlowCollection = require_resolve_flow_collection();
    function resolveCollection(CN, ctx, token, onError, tagName, tag) {
      const coll = token.type === "block-map" ? resolveBlockMap.resolveBlockMap(CN, ctx, token, onError, tag) : token.type === "block-seq" ? resolveBlockSeq.resolveBlockSeq(CN, ctx, token, onError, tag) : resolveFlowCollection.resolveFlowCollection(CN, ctx, token, onError, tag);
      const Coll = coll.constructor;
      if (tagName === "!" || tagName === Coll.tagName) {
        coll.tag = Coll.tagName;
        return coll;
      }
      if (tagName)
        coll.tag = tagName;
      return coll;
    }
    function composeCollection(CN, ctx, token, props, onError) {
      const tagToken = props.tag;
      const tagName = !tagToken ? null : ctx.directives.tagName(tagToken.source, (msg) => onError(tagToken, "TAG_RESOLVE_FAILED", msg));
      if (token.type === "block-seq") {
        const { anchor, newlineAfterProp: nl } = props;
        const lastProp = anchor && tagToken ? anchor.offset > tagToken.offset ? anchor : tagToken : anchor ?? tagToken;
        if (lastProp && (!nl || nl.offset < lastProp.offset)) {
          const message = "Missing newline after block sequence props";
          onError(lastProp, "MISSING_CHAR", message);
        }
      }
      const expType = token.type === "block-map" ? "map" : token.type === "block-seq" ? "seq" : token.start.source === "{" ? "map" : "seq";
      if (!tagToken || !tagName || tagName === "!" || tagName === YAMLMap.YAMLMap.tagName && expType === "map" || tagName === YAMLSeq.YAMLSeq.tagName && expType === "seq") {
        return resolveCollection(CN, ctx, token, onError, tagName);
      }
      let tag = ctx.schema.tags.find((t) => t.tag === tagName && t.collection === expType);
      if (!tag) {
        const kt = ctx.schema.knownTags[tagName];
        if (kt?.collection === expType) {
          ctx.schema.tags.push(Object.assign({}, kt, { default: false }));
          tag = kt;
        } else {
          if (kt) {
            onError(tagToken, "BAD_COLLECTION_TYPE", `${kt.tag} used for ${expType} collection, but expects ${kt.collection ?? "scalar"}`, true);
          } else {
            onError(tagToken, "TAG_RESOLVE_FAILED", `Unresolved tag: ${tagName}`, true);
          }
          return resolveCollection(CN, ctx, token, onError, tagName);
        }
      }
      const coll = resolveCollection(CN, ctx, token, onError, tagName, tag);
      const res = tag.resolve?.(coll, (msg) => onError(tagToken, "TAG_RESOLVE_FAILED", msg), ctx.options) ?? coll;
      const node2 = identity.isNode(res) ? res : new Scalar.Scalar(res);
      node2.range = coll.range;
      node2.tag = tagName;
      if (tag?.format)
        node2.format = tag.format;
      return node2;
    }
    exports.composeCollection = composeCollection;
  }
});

// node_modules/yaml/dist/compose/resolve-block-scalar.js
var require_resolve_block_scalar = __commonJS({
  "node_modules/yaml/dist/compose/resolve-block-scalar.js"(exports) {
    "use strict";
    var Scalar = require_Scalar();
    function resolveBlockScalar(ctx, scalar, onError) {
      const start2 = scalar.offset;
      const header = parseBlockScalarHeader(scalar, ctx.options.strict, onError);
      if (!header)
        return { value: "", type: null, comment: "", range: [start2, start2, start2] };
      const type = header.mode === ">" ? Scalar.Scalar.BLOCK_FOLDED : Scalar.Scalar.BLOCK_LITERAL;
      const lines2 = scalar.source ? splitLines(scalar.source) : [];
      let chompStart = lines2.length;
      for (let i = lines2.length - 1; i >= 0; --i) {
        const content4 = lines2[i][1];
        if (content4 === "" || content4 === "\r")
          chompStart = i;
        else
          break;
      }
      if (chompStart === 0) {
        const value2 = header.chomp === "+" && lines2.length > 0 ? "\n".repeat(Math.max(1, lines2.length - 1)) : "";
        let end3 = start2 + header.length;
        if (scalar.source)
          end3 += scalar.source.length;
        return { value: value2, type, comment: header.comment, range: [start2, end3, end3] };
      }
      let trimIndent = scalar.indent + header.indent;
      let offset = scalar.offset + header.length;
      let contentStart = 0;
      for (let i = 0; i < chompStart; ++i) {
        const [indent2, content4] = lines2[i];
        if (content4 === "" || content4 === "\r") {
          if (header.indent === 0 && indent2.length > trimIndent)
            trimIndent = indent2.length;
        } else {
          if (indent2.length < trimIndent) {
            const message = "Block scalars with more-indented leading empty lines must use an explicit indentation indicator";
            onError(offset + indent2.length, "MISSING_CHAR", message);
          }
          if (header.indent === 0)
            trimIndent = indent2.length;
          contentStart = i;
          if (trimIndent === 0 && !ctx.atRoot) {
            const message = "Block scalar values in collections must be indented";
            onError(offset, "BAD_INDENT", message);
          }
          break;
        }
        offset += indent2.length + content4.length + 1;
      }
      for (let i = lines2.length - 1; i >= chompStart; --i) {
        if (lines2[i][0].length > trimIndent)
          chompStart = i + 1;
      }
      let value = "";
      let sep3 = "";
      let prevMoreIndented = false;
      for (let i = 0; i < contentStart; ++i)
        value += lines2[i][0].slice(trimIndent) + "\n";
      for (let i = contentStart; i < chompStart; ++i) {
        let [indent2, content4] = lines2[i];
        offset += indent2.length + content4.length + 1;
        const crlf = content4[content4.length - 1] === "\r";
        if (crlf)
          content4 = content4.slice(0, -1);
        if (content4 && indent2.length < trimIndent) {
          const src = header.indent ? "explicit indentation indicator" : "first line";
          const message = `Block scalar lines must not be less indented than their ${src}`;
          onError(offset - content4.length - (crlf ? 2 : 1), "BAD_INDENT", message);
          indent2 = "";
        }
        if (type === Scalar.Scalar.BLOCK_LITERAL) {
          value += sep3 + indent2.slice(trimIndent) + content4;
          sep3 = "\n";
        } else if (indent2.length > trimIndent || content4[0] === "	") {
          if (sep3 === " ")
            sep3 = "\n";
          else if (!prevMoreIndented && sep3 === "\n")
            sep3 = "\n\n";
          value += sep3 + indent2.slice(trimIndent) + content4;
          sep3 = "\n";
          prevMoreIndented = true;
        } else if (content4 === "") {
          if (sep3 === "\n")
            value += "\n";
          else
            sep3 = "\n";
        } else {
          value += sep3 + content4;
          sep3 = " ";
          prevMoreIndented = false;
        }
      }
      switch (header.chomp) {
        case "-":
          break;
        case "+":
          for (let i = chompStart; i < lines2.length; ++i)
            value += "\n" + lines2[i][0].slice(trimIndent);
          if (value[value.length - 1] !== "\n")
            value += "\n";
          break;
        default:
          value += "\n";
      }
      const end2 = start2 + header.length + scalar.source.length;
      return { value, type, comment: header.comment, range: [start2, end2, end2] };
    }
    function parseBlockScalarHeader({ offset, props }, strict, onError) {
      if (props[0].type !== "block-scalar-header") {
        onError(props[0], "IMPOSSIBLE", "Block scalar header not found");
        return null;
      }
      const { source } = props[0];
      const mode = source[0];
      let indent2 = 0;
      let chomp = "";
      let error = -1;
      for (let i = 1; i < source.length; ++i) {
        const ch = source[i];
        if (!chomp && (ch === "-" || ch === "+"))
          chomp = ch;
        else {
          const n = Number(ch);
          if (!indent2 && n)
            indent2 = n;
          else if (error === -1)
            error = offset + i;
        }
      }
      if (error !== -1)
        onError(error, "UNEXPECTED_TOKEN", `Block scalar header includes extra characters: ${source}`);
      let hasSpace = false;
      let comment = "";
      let length = source.length;
      for (let i = 1; i < props.length; ++i) {
        const token = props[i];
        switch (token.type) {
          case "space":
            hasSpace = true;
          // fallthrough
          case "newline":
            length += token.source.length;
            break;
          case "comment":
            if (strict && !hasSpace) {
              const message = "Comments must be separated from other tokens by white space characters";
              onError(token, "MISSING_CHAR", message);
            }
            length += token.source.length;
            comment = token.source.substring(1);
            break;
          case "error":
            onError(token, "UNEXPECTED_TOKEN", token.message);
            length += token.source.length;
            break;
          /* istanbul ignore next should not happen */
          default: {
            const message = `Unexpected token in block scalar header: ${token.type}`;
            onError(token, "UNEXPECTED_TOKEN", message);
            const ts = token.source;
            if (ts && typeof ts === "string")
              length += ts.length;
          }
        }
      }
      return { mode, indent: indent2, chomp, comment, length };
    }
    function splitLines(source) {
      const split = source.split(/\n( *)/);
      const first = split[0];
      const m = first.match(/^( *)/);
      const line0 = m?.[1] ? [m[1], first.slice(m[1].length)] : ["", first];
      const lines2 = [line0];
      for (let i = 1; i < split.length; i += 2)
        lines2.push([split[i], split[i + 1]]);
      return lines2;
    }
    exports.resolveBlockScalar = resolveBlockScalar;
  }
});

// node_modules/yaml/dist/compose/resolve-flow-scalar.js
var require_resolve_flow_scalar = __commonJS({
  "node_modules/yaml/dist/compose/resolve-flow-scalar.js"(exports) {
    "use strict";
    var Scalar = require_Scalar();
    var resolveEnd = require_resolve_end();
    function resolveFlowScalar(scalar, strict, onError) {
      const { offset, type, source, end: end2 } = scalar;
      let _type;
      let value;
      const _onError = (rel, code2, msg) => onError(offset + rel, code2, msg);
      switch (type) {
        case "scalar":
          _type = Scalar.Scalar.PLAIN;
          value = plainValue(source, _onError);
          break;
        case "single-quoted-scalar":
          _type = Scalar.Scalar.QUOTE_SINGLE;
          value = singleQuotedValue(source, _onError);
          break;
        case "double-quoted-scalar":
          _type = Scalar.Scalar.QUOTE_DOUBLE;
          value = doubleQuotedValue(source, _onError);
          break;
        /* istanbul ignore next should not happen */
        default:
          onError(scalar, "UNEXPECTED_TOKEN", `Expected a flow scalar value, but found: ${type}`);
          return {
            value: "",
            type: null,
            comment: "",
            range: [offset, offset + source.length, offset + source.length]
          };
      }
      const valueEnd = offset + source.length;
      const re = resolveEnd.resolveEnd(end2, valueEnd, strict, onError);
      return {
        value,
        type: _type,
        comment: re.comment,
        range: [offset, valueEnd, re.offset]
      };
    }
    function plainValue(source, onError) {
      let badChar = "";
      switch (source[0]) {
        /* istanbul ignore next should not happen */
        case "	":
          badChar = "a tab character";
          break;
        case ",":
          badChar = "flow indicator character ,";
          break;
        case "%":
          badChar = "directive indicator character %";
          break;
        case "|":
        case ">": {
          badChar = `block scalar indicator ${source[0]}`;
          break;
        }
        case "@":
        case "`": {
          badChar = `reserved character ${source[0]}`;
          break;
        }
      }
      if (badChar)
        onError(0, "BAD_SCALAR_START", `Plain value cannot start with ${badChar}`);
      return unfoldLines(source);
    }
    function singleQuotedValue(source, onError) {
      if (source[source.length - 1] !== "'" || source.length === 1)
        onError(source.length, "MISSING_CHAR", "Missing closing 'quote");
      return unfoldLines(source.slice(1, -1)).replace(/''/g, "'");
    }
    function unfoldLines(source) {
      const line2 = /(.*?)\r?\n/sy;
      let match = line2.exec(source);
      if (!match)
        return source;
      let trimEnd, trimBoth;
      try {
        trimEnd = new RegExp("(?<![ 	])[ 	]+$");
        trimBoth = new RegExp("^[ 	]+|(?<![ 	])[ 	]+$", "g");
      } catch {
        trimEnd = /[ \t]+$/;
        trimBoth = /^[ \t]+|[ \t]+$/g;
      }
      let res = match[1].replace(trimEnd, "");
      let sep3 = " ";
      let pos = line2.lastIndex;
      while (match = line2.exec(source)) {
        const lm = match[1].replace(trimBoth, "");
        if (lm === "") {
          if (sep3 === "\n")
            res += sep3;
          else
            sep3 = "\n";
        } else {
          res += sep3 + lm;
          sep3 = " ";
        }
        pos = line2.lastIndex;
      }
      const last = /[ \t]*(.*)/sy;
      last.lastIndex = pos;
      match = last.exec(source);
      return res + sep3 + (match?.[1] ?? "");
    }
    function doubleQuotedValue(source, onError) {
      let res = "";
      for (let i = 1; i < source.length - 1; ++i) {
        const ch = source[i];
        if (ch === "\r" && source[i + 1] === "\n")
          continue;
        if (ch === "\n") {
          const { fold, offset } = foldNewline(source, i);
          res += fold;
          i = offset;
        } else if (ch === "\\") {
          let next = source[++i];
          const cc = escapeCodes[next];
          if (cc)
            res += cc;
          else if (next === "\n") {
            next = source[i + 1];
            while (next === " " || next === "	")
              next = source[++i + 1];
          } else if (next === "\r" && source[i + 1] === "\n") {
            next = source[++i + 1];
            while (next === " " || next === "	")
              next = source[++i + 1];
          } else if (next === "x" || next === "u" || next === "U") {
            const length = next === "x" ? 2 : next === "u" ? 4 : 8;
            res += parseCharCode(source, i + 1, length, onError);
            i += length;
          } else {
            const raw = source.substr(i - 1, 2);
            onError(i - 1, "BAD_DQ_ESCAPE", `Invalid escape sequence ${raw}`);
            res += raw;
          }
        } else if (ch === " " || ch === "	") {
          const wsStart = i;
          let next = source[i + 1];
          while (next === " " || next === "	")
            next = source[++i + 1];
          if (next !== "\n" && !(next === "\r" && source[i + 2] === "\n"))
            res += i > wsStart ? source.slice(wsStart, i + 1) : ch;
        } else {
          res += ch;
        }
      }
      if (source[source.length - 1] !== '"' || source.length === 1)
        onError(source.length, "MISSING_CHAR", 'Missing closing "quote');
      return res;
    }
    function foldNewline(source, offset) {
      let fold = "";
      let ch = source[offset + 1];
      while (ch === " " || ch === "	" || ch === "\n" || ch === "\r") {
        if (ch === "\r" && source[offset + 2] !== "\n")
          break;
        if (ch === "\n")
          fold += "\n";
        offset += 1;
        ch = source[offset + 1];
      }
      if (!fold)
        fold = " ";
      return { fold, offset };
    }
    var escapeCodes = {
      "0": "\0",
      // null character
      a: "\x07",
      // bell character
      b: "\b",
      // backspace
      e: "\x1B",
      // escape character
      f: "\f",
      // form feed
      n: "\n",
      // line feed
      r: "\r",
      // carriage return
      t: "	",
      // horizontal tab
      v: "\v",
      // vertical tab
      N: "\x85",
      // Unicode next line
      _: "\xA0",
      // Unicode non-breaking space
      L: "\u2028",
      // Unicode line separator
      P: "\u2029",
      // Unicode paragraph separator
      " ": " ",
      '"': '"',
      "/": "/",
      "\\": "\\",
      "	": "	"
    };
    function parseCharCode(source, offset, length, onError) {
      const cc = source.substr(offset, length);
      const ok3 = cc.length === length && /^[0-9a-fA-F]+$/.test(cc);
      const code2 = ok3 ? parseInt(cc, 16) : NaN;
      try {
        return String.fromCodePoint(code2);
      } catch {
        const raw = source.substr(offset - 2, length + 2);
        onError(offset - 2, "BAD_DQ_ESCAPE", `Invalid escape sequence ${raw}`);
        return raw;
      }
    }
    exports.resolveFlowScalar = resolveFlowScalar;
  }
});

// node_modules/yaml/dist/compose/compose-scalar.js
var require_compose_scalar = __commonJS({
  "node_modules/yaml/dist/compose/compose-scalar.js"(exports) {
    "use strict";
    var identity = require_identity();
    var Scalar = require_Scalar();
    var resolveBlockScalar = require_resolve_block_scalar();
    var resolveFlowScalar = require_resolve_flow_scalar();
    function composeScalar(ctx, token, tagToken, onError) {
      const { value, type, comment, range } = token.type === "block-scalar" ? resolveBlockScalar.resolveBlockScalar(ctx, token, onError) : resolveFlowScalar.resolveFlowScalar(token, ctx.options.strict, onError);
      const tagName = tagToken ? ctx.directives.tagName(tagToken.source, (msg) => onError(tagToken, "TAG_RESOLVE_FAILED", msg)) : null;
      let tag;
      if (ctx.options.stringKeys && ctx.atKey) {
        tag = ctx.schema[identity.SCALAR];
      } else if (tagName)
        tag = findScalarTagByName(ctx.schema, value, tagName, tagToken, onError);
      else if (token.type === "scalar")
        tag = findScalarTagByTest(ctx, value, token, onError);
      else
        tag = ctx.schema[identity.SCALAR];
      let scalar;
      try {
        const res = tag.resolve(value, (msg) => onError(tagToken ?? token, "TAG_RESOLVE_FAILED", msg), ctx.options);
        scalar = identity.isScalar(res) ? res : new Scalar.Scalar(res);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        onError(tagToken ?? token, "TAG_RESOLVE_FAILED", msg);
        scalar = new Scalar.Scalar(value);
      }
      scalar.range = range;
      scalar.source = value;
      if (type)
        scalar.type = type;
      if (tagName)
        scalar.tag = tagName;
      if (tag.format)
        scalar.format = tag.format;
      if (comment)
        scalar.comment = comment;
      return scalar;
    }
    function findScalarTagByName(schema, value, tagName, tagToken, onError) {
      if (tagName === "!")
        return schema[identity.SCALAR];
      const matchWithTest = [];
      for (const tag of schema.tags) {
        if (!tag.collection && tag.tag === tagName) {
          if (tag.default && tag.test)
            matchWithTest.push(tag);
          else
            return tag;
        }
      }
      for (const tag of matchWithTest)
        if (tag.test?.test(value))
          return tag;
      const kt = schema.knownTags[tagName];
      if (kt && !kt.collection) {
        schema.tags.push(Object.assign({}, kt, { default: false, test: void 0 }));
        return kt;
      }
      onError(tagToken, "TAG_RESOLVE_FAILED", `Unresolved tag: ${tagName}`, tagName !== "tag:yaml.org,2002:str");
      return schema[identity.SCALAR];
    }
    function findScalarTagByTest({ atKey, directives, schema }, value, token, onError) {
      const tag = schema.tags.find((tag2) => (tag2.default === true || atKey && tag2.default === "key") && tag2.test?.test(value)) || schema[identity.SCALAR];
      if (schema.compat) {
        const compat = schema.compat.find((tag2) => tag2.default && tag2.test?.test(value)) ?? schema[identity.SCALAR];
        if (tag.tag !== compat.tag) {
          const ts = directives.tagString(tag.tag);
          const cs = directives.tagString(compat.tag);
          const msg = `Value may be parsed as either ${ts} or ${cs}`;
          onError(token, "TAG_RESOLVE_FAILED", msg, true);
        }
      }
      return tag;
    }
    exports.composeScalar = composeScalar;
  }
});

// node_modules/yaml/dist/compose/util-empty-scalar-position.js
var require_util_empty_scalar_position = __commonJS({
  "node_modules/yaml/dist/compose/util-empty-scalar-position.js"(exports) {
    "use strict";
    function emptyScalarPosition(offset, before, pos) {
      if (before) {
        pos ?? (pos = before.length);
        for (let i = pos - 1; i >= 0; --i) {
          let st = before[i];
          switch (st.type) {
            case "space":
            case "comment":
            case "newline":
              offset -= st.source.length;
              continue;
          }
          st = before[++i];
          while (st?.type === "space") {
            offset += st.source.length;
            st = before[++i];
          }
          break;
        }
      }
      return offset;
    }
    exports.emptyScalarPosition = emptyScalarPosition;
  }
});

// node_modules/yaml/dist/compose/compose-node.js
var require_compose_node = __commonJS({
  "node_modules/yaml/dist/compose/compose-node.js"(exports) {
    "use strict";
    var Alias = require_Alias();
    var identity = require_identity();
    var composeCollection = require_compose_collection();
    var composeScalar = require_compose_scalar();
    var resolveEnd = require_resolve_end();
    var utilEmptyScalarPosition = require_util_empty_scalar_position();
    var CN = { composeNode, composeEmptyNode };
    function composeNode(ctx, token, props, onError) {
      const atKey = ctx.atKey;
      const { spaceBefore, comment, anchor, tag } = props;
      let node2;
      let isSrcToken = true;
      switch (token.type) {
        case "alias":
          node2 = composeAlias(ctx, token, onError);
          if (anchor || tag)
            onError(token, "ALIAS_PROPS", "An alias node must not specify any properties");
          break;
        case "scalar":
        case "single-quoted-scalar":
        case "double-quoted-scalar":
        case "block-scalar":
          node2 = composeScalar.composeScalar(ctx, token, tag, onError);
          if (anchor)
            node2.anchor = anchor.source.substring(1);
          break;
        case "block-map":
        case "block-seq":
        case "flow-collection":
          try {
            node2 = composeCollection.composeCollection(CN, ctx, token, props, onError);
            if (anchor)
              node2.anchor = anchor.source.substring(1);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            onError(token, "RESOURCE_EXHAUSTION", message);
          }
          break;
        default: {
          const message = token.type === "error" ? token.message : `Unsupported token (type: ${token.type})`;
          onError(token, "UNEXPECTED_TOKEN", message);
          isSrcToken = false;
        }
      }
      node2 ?? (node2 = composeEmptyNode(ctx, token.offset, void 0, null, props, onError));
      if (anchor && node2.anchor === "")
        onError(anchor, "BAD_ALIAS", "Anchor cannot be an empty string");
      if (atKey && ctx.options.stringKeys && (!identity.isScalar(node2) || typeof node2.value !== "string" || node2.tag && node2.tag !== "tag:yaml.org,2002:str")) {
        const msg = "With stringKeys, all keys must be strings";
        onError(tag ?? token, "NON_STRING_KEY", msg);
      }
      if (spaceBefore)
        node2.spaceBefore = true;
      if (comment) {
        if (token.type === "scalar" && token.source === "")
          node2.comment = comment;
        else
          node2.commentBefore = comment;
      }
      if (ctx.options.keepSourceTokens && isSrcToken)
        node2.srcToken = token;
      return node2;
    }
    function composeEmptyNode(ctx, offset, before, pos, { spaceBefore, comment, anchor, tag, end: end2 }, onError) {
      const token = {
        type: "scalar",
        offset: utilEmptyScalarPosition.emptyScalarPosition(offset, before, pos),
        indent: -1,
        source: ""
      };
      const node2 = composeScalar.composeScalar(ctx, token, tag, onError);
      if (anchor) {
        node2.anchor = anchor.source.substring(1);
        if (node2.anchor === "")
          onError(anchor, "BAD_ALIAS", "Anchor cannot be an empty string");
      }
      if (spaceBefore)
        node2.spaceBefore = true;
      if (comment) {
        node2.comment = comment;
        node2.range[2] = end2;
      }
      return node2;
    }
    function composeAlias({ options }, { offset, source, end: end2 }, onError) {
      const alias = new Alias.Alias(source.substring(1));
      if (alias.source === "")
        onError(offset, "BAD_ALIAS", "Alias cannot be an empty string");
      if (alias.source.endsWith(":"))
        onError(offset + source.length - 1, "BAD_ALIAS", "Alias ending in : is ambiguous", true);
      const valueEnd = offset + source.length;
      const re = resolveEnd.resolveEnd(end2, valueEnd, options.strict, onError);
      alias.range = [offset, valueEnd, re.offset];
      if (re.comment)
        alias.comment = re.comment;
      return alias;
    }
    exports.composeEmptyNode = composeEmptyNode;
    exports.composeNode = composeNode;
  }
});

// node_modules/yaml/dist/compose/compose-doc.js
var require_compose_doc = __commonJS({
  "node_modules/yaml/dist/compose/compose-doc.js"(exports) {
    "use strict";
    var Document = require_Document();
    var composeNode = require_compose_node();
    var resolveEnd = require_resolve_end();
    var resolveProps = require_resolve_props();
    function composeDoc(options, directives, { offset, start: start2, value, end: end2 }, onError) {
      const opts = Object.assign({ _directives: directives }, options);
      const doc = new Document.Document(void 0, opts);
      const ctx = {
        atKey: false,
        atRoot: true,
        directives: doc.directives,
        options: doc.options,
        schema: doc.schema
      };
      const props = resolveProps.resolveProps(start2, {
        indicator: "doc-start",
        next: value ?? end2?.[0],
        offset,
        onError,
        parentIndent: 0,
        startOnNewline: true
      });
      if (props.found) {
        doc.directives.docStart = true;
        if (value && (value.type === "block-map" || value.type === "block-seq") && !props.hasNewline)
          onError(props.end, "MISSING_CHAR", "Block collection cannot start on same line with directives-end marker");
      }
      doc.contents = value ? composeNode.composeNode(ctx, value, props, onError) : composeNode.composeEmptyNode(ctx, props.end, start2, null, props, onError);
      const contentEnd = doc.contents.range[2];
      const re = resolveEnd.resolveEnd(end2, contentEnd, false, onError);
      if (re.comment)
        doc.comment = re.comment;
      doc.range = [offset, contentEnd, re.offset];
      return doc;
    }
    exports.composeDoc = composeDoc;
  }
});

// node_modules/yaml/dist/compose/composer.js
var require_composer = __commonJS({
  "node_modules/yaml/dist/compose/composer.js"(exports) {
    "use strict";
    var node_process = __require("process");
    var directives = require_directives();
    var Document = require_Document();
    var errors = require_errors();
    var identity = require_identity();
    var composeDoc = require_compose_doc();
    var resolveEnd = require_resolve_end();
    function getErrorPos(src) {
      if (typeof src === "number")
        return [src, src + 1];
      if (Array.isArray(src))
        return src.length === 2 ? src : [src[0], src[1]];
      const { offset, source } = src;
      return [offset, offset + (typeof source === "string" ? source.length : 1)];
    }
    function parsePrelude(prelude) {
      let comment = "";
      let atComment = false;
      let afterEmptyLine = false;
      for (let i = 0; i < prelude.length; ++i) {
        const source = prelude[i];
        switch (source[0]) {
          case "#":
            comment += (comment === "" ? "" : afterEmptyLine ? "\n\n" : "\n") + (source.substring(1) || " ");
            atComment = true;
            afterEmptyLine = false;
            break;
          case "%":
            if (prelude[i + 1]?.[0] !== "#")
              i += 1;
            atComment = false;
            break;
          default:
            if (!atComment)
              afterEmptyLine = true;
            atComment = false;
        }
      }
      return { comment, afterEmptyLine };
    }
    var Composer = class {
      constructor(options = {}) {
        this.doc = null;
        this.atDirectives = false;
        this.prelude = [];
        this.errors = [];
        this.warnings = [];
        this.onError = (source, code2, message, warning) => {
          const pos = getErrorPos(source);
          if (warning)
            this.warnings.push(new errors.YAMLWarning(pos, code2, message));
          else
            this.errors.push(new errors.YAMLParseError(pos, code2, message));
        };
        this.directives = new directives.Directives({ version: options.version || "1.2" });
        this.options = options;
      }
      decorate(doc, afterDoc) {
        const { comment, afterEmptyLine } = parsePrelude(this.prelude);
        if (comment) {
          const dc = doc.contents;
          if (afterDoc) {
            doc.comment = doc.comment ? `${doc.comment}
${comment}` : comment;
          } else if (afterEmptyLine || doc.directives.docStart || !dc) {
            doc.commentBefore = comment;
          } else if (identity.isCollection(dc) && !dc.flow && dc.items.length > 0) {
            let it = dc.items[0];
            if (identity.isPair(it))
              it = it.key;
            const cb = it.commentBefore;
            it.commentBefore = cb ? `${comment}
${cb}` : comment;
          } else {
            const cb = dc.commentBefore;
            dc.commentBefore = cb ? `${comment}
${cb}` : comment;
          }
        }
        if (afterDoc) {
          for (let i = 0; i < this.errors.length; ++i)
            doc.errors.push(this.errors[i]);
          for (let i = 0; i < this.warnings.length; ++i)
            doc.warnings.push(this.warnings[i]);
        } else {
          doc.errors = this.errors;
          doc.warnings = this.warnings;
        }
        this.prelude = [];
        this.errors = [];
        this.warnings = [];
      }
      /**
       * Current stream status information.
       *
       * Mostly useful at the end of input for an empty stream.
       */
      streamInfo() {
        return {
          comment: parsePrelude(this.prelude).comment,
          directives: this.directives,
          errors: this.errors,
          warnings: this.warnings
        };
      }
      /**
       * Compose tokens into documents.
       *
       * @param forceDoc - If the stream contains no document, still emit a final document including any comments and directives that would be applied to a subsequent document.
       * @param endOffset - Should be set if `forceDoc` is also set, to set the document range end and to indicate errors correctly.
       */
      *compose(tokens, forceDoc = false, endOffset = -1) {
        for (const token of tokens)
          yield* this.next(token);
        yield* this.end(forceDoc, endOffset);
      }
      /** Advance the composer by one CST token. */
      *next(token) {
        if (node_process.env.LOG_STREAM)
          console.dir(token, { depth: null });
        switch (token.type) {
          case "directive":
            this.directives.add(token.source, (offset, message, warning) => {
              const pos = getErrorPos(token);
              pos[0] += offset;
              this.onError(pos, "BAD_DIRECTIVE", message, warning);
            });
            this.prelude.push(token.source);
            this.atDirectives = true;
            break;
          case "document": {
            const doc = composeDoc.composeDoc(this.options, this.directives, token, this.onError);
            if (this.atDirectives && !doc.directives.docStart)
              this.onError(token, "MISSING_CHAR", "Missing directives-end/doc-start indicator line");
            this.decorate(doc, false);
            if (this.doc)
              yield this.doc;
            this.doc = doc;
            this.atDirectives = false;
            break;
          }
          case "byte-order-mark":
          case "space":
            break;
          case "comment":
          case "newline":
            this.prelude.push(token.source);
            break;
          case "error": {
            const msg = token.source ? `${token.message}: ${JSON.stringify(token.source)}` : token.message;
            const error = new errors.YAMLParseError(getErrorPos(token), "UNEXPECTED_TOKEN", msg);
            if (this.atDirectives || !this.doc)
              this.errors.push(error);
            else
              this.doc.errors.push(error);
            break;
          }
          case "doc-end": {
            if (!this.doc) {
              const msg = "Unexpected doc-end without preceding document";
              this.errors.push(new errors.YAMLParseError(getErrorPos(token), "UNEXPECTED_TOKEN", msg));
              break;
            }
            this.doc.directives.docEnd = true;
            const end2 = resolveEnd.resolveEnd(token.end, token.offset + token.source.length, this.doc.options.strict, this.onError);
            this.decorate(this.doc, true);
            if (end2.comment) {
              const dc = this.doc.comment;
              this.doc.comment = dc ? `${dc}
${end2.comment}` : end2.comment;
            }
            this.doc.range[2] = end2.offset;
            break;
          }
          default:
            this.errors.push(new errors.YAMLParseError(getErrorPos(token), "UNEXPECTED_TOKEN", `Unsupported token ${token.type}`));
        }
      }
      /**
       * Call at end of input to yield any remaining document.
       *
       * @param forceDoc - If the stream contains no document, still emit a final document including any comments and directives that would be applied to a subsequent document.
       * @param endOffset - Should be set if `forceDoc` is also set, to set the document range end and to indicate errors correctly.
       */
      *end(forceDoc = false, endOffset = -1) {
        if (this.doc) {
          this.decorate(this.doc, true);
          yield this.doc;
          this.doc = null;
        } else if (forceDoc) {
          const opts = Object.assign({ _directives: this.directives }, this.options);
          const doc = new Document.Document(void 0, opts);
          if (this.atDirectives)
            this.onError(endOffset, "MISSING_CHAR", "Missing directives-end indicator line");
          doc.range = [0, endOffset, endOffset];
          this.decorate(doc, false);
          yield doc;
        }
      }
    };
    exports.Composer = Composer;
  }
});

// node_modules/yaml/dist/parse/cst-scalar.js
var require_cst_scalar = __commonJS({
  "node_modules/yaml/dist/parse/cst-scalar.js"(exports) {
    "use strict";
    var resolveBlockScalar = require_resolve_block_scalar();
    var resolveFlowScalar = require_resolve_flow_scalar();
    var errors = require_errors();
    var stringifyString = require_stringifyString();
    function resolveAsScalar(token, strict = true, onError) {
      if (token) {
        const _onError = (pos, code2, message) => {
          const offset = typeof pos === "number" ? pos : Array.isArray(pos) ? pos[0] : pos.offset;
          if (onError)
            onError(offset, code2, message);
          else
            throw new errors.YAMLParseError([offset, offset + 1], code2, message);
        };
        switch (token.type) {
          case "scalar":
          case "single-quoted-scalar":
          case "double-quoted-scalar":
            return resolveFlowScalar.resolveFlowScalar(token, strict, _onError);
          case "block-scalar":
            return resolveBlockScalar.resolveBlockScalar({ options: { strict } }, token, _onError);
        }
      }
      return null;
    }
    function createScalarToken(value, context) {
      const { implicitKey = false, indent: indent2, inFlow = false, offset = -1, type = "PLAIN" } = context;
      const source = stringifyString.stringifyString({ type, value }, {
        implicitKey,
        indent: indent2 > 0 ? " ".repeat(indent2) : "",
        inFlow,
        options: { blockQuote: true, lineWidth: -1 }
      });
      const end2 = context.end ?? [
        { type: "newline", offset: -1, indent: indent2, source: "\n" }
      ];
      switch (source[0]) {
        case "|":
        case ">": {
          const he = source.indexOf("\n");
          const head = source.substring(0, he);
          const body2 = source.substring(he + 1) + "\n";
          const props = [
            { type: "block-scalar-header", offset, indent: indent2, source: head }
          ];
          if (!addEndtoBlockProps(props, end2))
            props.push({ type: "newline", offset: -1, indent: indent2, source: "\n" });
          return { type: "block-scalar", offset, indent: indent2, props, source: body2 };
        }
        case '"':
          return { type: "double-quoted-scalar", offset, indent: indent2, source, end: end2 };
        case "'":
          return { type: "single-quoted-scalar", offset, indent: indent2, source, end: end2 };
        default:
          return { type: "scalar", offset, indent: indent2, source, end: end2 };
      }
    }
    function setScalarValue(token, value, context = {}) {
      let { afterKey = false, implicitKey = false, inFlow = false, type } = context;
      let indent2 = "indent" in token ? token.indent : null;
      if (afterKey && typeof indent2 === "number")
        indent2 += 2;
      if (!type)
        switch (token.type) {
          case "single-quoted-scalar":
            type = "QUOTE_SINGLE";
            break;
          case "double-quoted-scalar":
            type = "QUOTE_DOUBLE";
            break;
          case "block-scalar": {
            const header = token.props[0];
            if (header.type !== "block-scalar-header")
              throw new Error("Invalid block scalar header");
            type = header.source[0] === ">" ? "BLOCK_FOLDED" : "BLOCK_LITERAL";
            break;
          }
          default:
            type = "PLAIN";
        }
      const source = stringifyString.stringifyString({ type, value }, {
        implicitKey: implicitKey || indent2 === null,
        indent: indent2 !== null && indent2 > 0 ? " ".repeat(indent2) : "",
        inFlow,
        options: { blockQuote: true, lineWidth: -1 }
      });
      switch (source[0]) {
        case "|":
        case ">":
          setBlockScalarValue(token, source);
          break;
        case '"':
          setFlowScalarValue(token, source, "double-quoted-scalar");
          break;
        case "'":
          setFlowScalarValue(token, source, "single-quoted-scalar");
          break;
        default:
          setFlowScalarValue(token, source, "scalar");
      }
    }
    function setBlockScalarValue(token, source) {
      const he = source.indexOf("\n");
      const head = source.substring(0, he);
      const body2 = source.substring(he + 1) + "\n";
      if (token.type === "block-scalar") {
        const header = token.props[0];
        if (header.type !== "block-scalar-header")
          throw new Error("Invalid block scalar header");
        header.source = head;
        token.source = body2;
      } else {
        const { offset } = token;
        const indent2 = "indent" in token ? token.indent : -1;
        const props = [
          { type: "block-scalar-header", offset, indent: indent2, source: head }
        ];
        if (!addEndtoBlockProps(props, "end" in token ? token.end : void 0))
          props.push({ type: "newline", offset: -1, indent: indent2, source: "\n" });
        for (const key of Object.keys(token))
          if (key !== "type" && key !== "offset")
            delete token[key];
        Object.assign(token, { type: "block-scalar", indent: indent2, props, source: body2 });
      }
    }
    function addEndtoBlockProps(props, end2) {
      if (end2)
        for (const st of end2)
          switch (st.type) {
            case "space":
            case "comment":
              props.push(st);
              break;
            case "newline":
              props.push(st);
              return true;
          }
      return false;
    }
    function setFlowScalarValue(token, source, type) {
      switch (token.type) {
        case "scalar":
        case "double-quoted-scalar":
        case "single-quoted-scalar":
          token.type = type;
          token.source = source;
          break;
        case "block-scalar": {
          const end2 = token.props.slice(1);
          let oa = source.length;
          if (token.props[0].type === "block-scalar-header")
            oa -= token.props[0].source.length;
          for (const tok of end2)
            tok.offset += oa;
          delete token.props;
          Object.assign(token, { type, source, end: end2 });
          break;
        }
        case "block-map":
        case "block-seq": {
          const offset = token.offset + source.length;
          const nl = { type: "newline", offset, indent: token.indent, source: "\n" };
          delete token.items;
          Object.assign(token, { type, source, end: [nl] });
          break;
        }
        default: {
          const indent2 = "indent" in token ? token.indent : -1;
          const end2 = "end" in token && Array.isArray(token.end) ? token.end.filter((st) => st.type === "space" || st.type === "comment" || st.type === "newline") : [];
          for (const key of Object.keys(token))
            if (key !== "type" && key !== "offset")
              delete token[key];
          Object.assign(token, { type, indent: indent2, source, end: end2 });
        }
      }
    }
    exports.createScalarToken = createScalarToken;
    exports.resolveAsScalar = resolveAsScalar;
    exports.setScalarValue = setScalarValue;
  }
});

// node_modules/yaml/dist/parse/cst-stringify.js
var require_cst_stringify = __commonJS({
  "node_modules/yaml/dist/parse/cst-stringify.js"(exports) {
    "use strict";
    var stringify2 = (cst) => "type" in cst ? stringifyToken(cst) : stringifyItem(cst);
    function stringifyToken(token) {
      switch (token.type) {
        case "block-scalar": {
          let res = "";
          for (const tok of token.props)
            res += stringifyToken(tok);
          return res + token.source;
        }
        case "block-map":
        case "block-seq": {
          let res = "";
          for (const item of token.items)
            res += stringifyItem(item);
          return res;
        }
        case "flow-collection": {
          let res = token.start.source;
          for (const item of token.items)
            res += stringifyItem(item);
          for (const st of token.end)
            res += st.source;
          return res;
        }
        case "document": {
          let res = stringifyItem(token);
          if (token.end)
            for (const st of token.end)
              res += st.source;
          return res;
        }
        default: {
          let res = token.source;
          if ("end" in token && token.end)
            for (const st of token.end)
              res += st.source;
          return res;
        }
      }
    }
    function stringifyItem({ start: start2, key, sep: sep3, value }) {
      let res = "";
      for (const st of start2)
        res += st.source;
      if (key)
        res += stringifyToken(key);
      if (sep3)
        for (const st of sep3)
          res += st.source;
      if (value)
        res += stringifyToken(value);
      return res;
    }
    exports.stringify = stringify2;
  }
});

// node_modules/yaml/dist/parse/cst-visit.js
var require_cst_visit = __commonJS({
  "node_modules/yaml/dist/parse/cst-visit.js"(exports) {
    "use strict";
    var BREAK = /* @__PURE__ */ Symbol("break visit");
    var SKIP2 = /* @__PURE__ */ Symbol("skip children");
    var REMOVE = /* @__PURE__ */ Symbol("remove item");
    function visit2(cst, visitor) {
      if ("type" in cst && cst.type === "document")
        cst = { start: cst.start, value: cst.value };
      _visit(Object.freeze([]), cst, visitor);
    }
    visit2.BREAK = BREAK;
    visit2.SKIP = SKIP2;
    visit2.REMOVE = REMOVE;
    visit2.itemAtPath = (cst, path2) => {
      let item = cst;
      for (const [field, index2] of path2) {
        const tok = item?.[field];
        if (tok && "items" in tok) {
          item = tok.items[index2];
        } else
          return void 0;
      }
      return item;
    };
    visit2.parentCollection = (cst, path2) => {
      const parent = visit2.itemAtPath(cst, path2.slice(0, -1));
      const field = path2[path2.length - 1][0];
      const coll = parent?.[field];
      if (coll && "items" in coll)
        return coll;
      throw new Error("Parent collection not found");
    };
    function _visit(path2, item, visitor) {
      let ctrl = visitor(item, path2);
      if (typeof ctrl === "symbol")
        return ctrl;
      for (const field of ["key", "value"]) {
        const token = item[field];
        if (token && "items" in token) {
          for (let i = 0; i < token.items.length; ++i) {
            const ci = _visit(Object.freeze(path2.concat([[field, i]])), token.items[i], visitor);
            if (typeof ci === "number")
              i = ci - 1;
            else if (ci === BREAK)
              return BREAK;
            else if (ci === REMOVE) {
              token.items.splice(i, 1);
              i -= 1;
            }
          }
          if (typeof ctrl === "function" && field === "key")
            ctrl = ctrl(item, path2);
        }
      }
      return typeof ctrl === "function" ? ctrl(item, path2) : ctrl;
    }
    exports.visit = visit2;
  }
});

// node_modules/yaml/dist/parse/cst.js
var require_cst = __commonJS({
  "node_modules/yaml/dist/parse/cst.js"(exports) {
    "use strict";
    var cstScalar = require_cst_scalar();
    var cstStringify = require_cst_stringify();
    var cstVisit = require_cst_visit();
    var BOM2 = "\uFEFF";
    var DOCUMENT = "";
    var FLOW_END = "";
    var SCALAR = "";
    var isCollection = (token) => !!token && "items" in token;
    var isScalar = (token) => !!token && (token.type === "scalar" || token.type === "single-quoted-scalar" || token.type === "double-quoted-scalar" || token.type === "block-scalar");
    function prettyToken(token) {
      switch (token) {
        case BOM2:
          return "<BOM>";
        case DOCUMENT:
          return "<DOC>";
        case FLOW_END:
          return "<FLOW_END>";
        case SCALAR:
          return "<SCALAR>";
        default:
          return JSON.stringify(token);
      }
    }
    function tokenType(source) {
      switch (source) {
        case BOM2:
          return "byte-order-mark";
        case DOCUMENT:
          return "doc-mode";
        case FLOW_END:
          return "flow-error-end";
        case SCALAR:
          return "scalar";
        case "---":
          return "doc-start";
        case "...":
          return "doc-end";
        case "":
        case "\n":
        case "\r\n":
          return "newline";
        case "-":
          return "seq-item-ind";
        case "?":
          return "explicit-key-ind";
        case ":":
          return "map-value-ind";
        case "{":
          return "flow-map-start";
        case "}":
          return "flow-map-end";
        case "[":
          return "flow-seq-start";
        case "]":
          return "flow-seq-end";
        case ",":
          return "comma";
      }
      switch (source[0]) {
        case " ":
        case "	":
          return "space";
        case "#":
          return "comment";
        case "%":
          return "directive-line";
        case "*":
          return "alias";
        case "&":
          return "anchor";
        case "!":
          return "tag";
        case "'":
          return "single-quoted-scalar";
        case '"':
          return "double-quoted-scalar";
        case "|":
        case ">":
          return "block-scalar-header";
      }
      return null;
    }
    exports.createScalarToken = cstScalar.createScalarToken;
    exports.resolveAsScalar = cstScalar.resolveAsScalar;
    exports.setScalarValue = cstScalar.setScalarValue;
    exports.stringify = cstStringify.stringify;
    exports.visit = cstVisit.visit;
    exports.BOM = BOM2;
    exports.DOCUMENT = DOCUMENT;
    exports.FLOW_END = FLOW_END;
    exports.SCALAR = SCALAR;
    exports.isCollection = isCollection;
    exports.isScalar = isScalar;
    exports.prettyToken = prettyToken;
    exports.tokenType = tokenType;
  }
});

// node_modules/yaml/dist/parse/lexer.js
var require_lexer = __commonJS({
  "node_modules/yaml/dist/parse/lexer.js"(exports) {
    "use strict";
    var cst = require_cst();
    function isEmpty(ch) {
      switch (ch) {
        case void 0:
        case " ":
        case "\n":
        case "\r":
        case "	":
          return true;
        default:
          return false;
      }
    }
    var hexDigits = new Set("0123456789ABCDEFabcdef");
    var tagChars = new Set("0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-#;/?:@&=+$_.!~*'()");
    var flowIndicatorChars = new Set(",[]{}");
    var invalidAnchorChars = new Set(" ,[]{}\n\r	");
    var isNotAnchorChar = (ch) => !ch || invalidAnchorChars.has(ch);
    var Lexer = class {
      constructor() {
        this.atEnd = false;
        this.blockScalarIndent = -1;
        this.blockScalarKeep = false;
        this.buffer = "";
        this.flowKey = false;
        this.flowLevel = 0;
        this.indentNext = 0;
        this.indentValue = 0;
        this.lineEndPos = null;
        this.next = null;
        this.pos = 0;
      }
      /**
       * Generate YAML tokens from the `source` string. If `incomplete`,
       * a part of the last line may be left as a buffer for the next call.
       *
       * @returns A generator of lexical tokens
       */
      *lex(source, incomplete = false) {
        if (source) {
          if (typeof source !== "string")
            throw TypeError("source is not a string");
          this.buffer = this.buffer ? this.buffer + source : source;
          this.lineEndPos = null;
        }
        this.atEnd = !incomplete;
        let next = this.next ?? "stream";
        while (next && (incomplete || this.hasChars(1)))
          next = yield* this.parseNext(next);
      }
      atLineEnd() {
        let i = this.pos;
        let ch = this.buffer[i];
        while (ch === " " || ch === "	")
          ch = this.buffer[++i];
        if (!ch || ch === "#" || ch === "\n")
          return true;
        if (ch === "\r")
          return this.buffer[i + 1] === "\n";
        return false;
      }
      charAt(n) {
        return this.buffer[this.pos + n];
      }
      continueScalar(offset) {
        let ch = this.buffer[offset];
        if (this.indentNext > 0) {
          let indent2 = 0;
          while (ch === " ")
            ch = this.buffer[++indent2 + offset];
          if (ch === "\r") {
            const next = this.buffer[indent2 + offset + 1];
            if (next === "\n" || !next && !this.atEnd)
              return offset + indent2 + 1;
          }
          return ch === "\n" || indent2 >= this.indentNext || !ch && !this.atEnd ? offset + indent2 : -1;
        }
        if (ch === "-" || ch === ".") {
          const dt = this.buffer.substr(offset, 3);
          if ((dt === "---" || dt === "...") && isEmpty(this.buffer[offset + 3]))
            return -1;
        }
        return offset;
      }
      getLine() {
        let end2 = this.lineEndPos;
        if (typeof end2 !== "number" || end2 !== -1 && end2 < this.pos) {
          end2 = this.buffer.indexOf("\n", this.pos);
          this.lineEndPos = end2;
        }
        if (end2 === -1)
          return this.atEnd ? this.buffer.substring(this.pos) : null;
        if (this.buffer[end2 - 1] === "\r")
          end2 -= 1;
        return this.buffer.substring(this.pos, end2);
      }
      hasChars(n) {
        return this.pos + n <= this.buffer.length;
      }
      setNext(state) {
        this.buffer = this.buffer.substring(this.pos);
        this.pos = 0;
        this.lineEndPos = null;
        this.next = state;
        return null;
      }
      peek(n) {
        return this.buffer.substr(this.pos, n);
      }
      *parseNext(next) {
        switch (next) {
          case "stream":
            return yield* this.parseStream();
          case "line-start":
            return yield* this.parseLineStart();
          case "block-start":
            return yield* this.parseBlockStart();
          case "doc":
            return yield* this.parseDocument();
          case "flow":
            return yield* this.parseFlowCollection();
          case "quoted-scalar":
            return yield* this.parseQuotedScalar();
          case "block-scalar":
            return yield* this.parseBlockScalar();
          case "plain-scalar":
            return yield* this.parsePlainScalar();
        }
      }
      *parseStream() {
        let line2 = this.getLine();
        if (line2 === null)
          return this.setNext("stream");
        if (line2[0] === cst.BOM) {
          yield* this.pushCount(1);
          line2 = line2.substring(1);
        }
        if (line2[0] === "%") {
          let dirEnd = line2.length;
          let cs = line2.indexOf("#");
          while (cs !== -1) {
            const ch = line2[cs - 1];
            if (ch === " " || ch === "	") {
              dirEnd = cs - 1;
              break;
            } else {
              cs = line2.indexOf("#", cs + 1);
            }
          }
          while (true) {
            const ch = line2[dirEnd - 1];
            if (ch === " " || ch === "	")
              dirEnd -= 1;
            else
              break;
          }
          const n = (yield* this.pushCount(dirEnd)) + (yield* this.pushSpaces(true));
          yield* this.pushCount(line2.length - n);
          this.pushNewline();
          return "stream";
        }
        if (this.atLineEnd()) {
          const sp = yield* this.pushSpaces(true);
          yield* this.pushCount(line2.length - sp);
          yield* this.pushNewline();
          return "stream";
        }
        yield cst.DOCUMENT;
        return yield* this.parseLineStart();
      }
      *parseLineStart() {
        const ch = this.charAt(0);
        if (!ch && !this.atEnd)
          return this.setNext("line-start");
        if (ch === "-" || ch === ".") {
          if (!this.atEnd && !this.hasChars(4))
            return this.setNext("line-start");
          const s = this.peek(3);
          if ((s === "---" || s === "...") && isEmpty(this.charAt(3))) {
            yield* this.pushCount(3);
            this.indentValue = 0;
            this.indentNext = 0;
            return s === "---" ? "doc" : "stream";
          }
        }
        this.indentValue = yield* this.pushSpaces(false);
        if (this.indentNext > this.indentValue && !isEmpty(this.charAt(1)))
          this.indentNext = this.indentValue;
        return yield* this.parseBlockStart();
      }
      *parseBlockStart() {
        const [ch0, ch1] = this.peek(2);
        if (!ch1 && !this.atEnd)
          return this.setNext("block-start");
        if ((ch0 === "-" || ch0 === "?" || ch0 === ":") && isEmpty(ch1)) {
          const n = (yield* this.pushCount(1)) + (yield* this.pushSpaces(true));
          this.indentNext = this.indentValue + 1;
          this.indentValue += n;
          return "block-start";
        }
        return "doc";
      }
      *parseDocument() {
        yield* this.pushSpaces(true);
        const line2 = this.getLine();
        if (line2 === null)
          return this.setNext("doc");
        let n = yield* this.pushIndicators();
        switch (line2[n]) {
          case "#":
            yield* this.pushCount(line2.length - n);
          // fallthrough
          case void 0:
            yield* this.pushNewline();
            return yield* this.parseLineStart();
          case "{":
          case "[":
            yield* this.pushCount(1);
            this.flowKey = false;
            this.flowLevel = 1;
            return "flow";
          case "}":
          case "]":
            yield* this.pushCount(1);
            return "doc";
          case "*":
            yield* this.pushUntil(isNotAnchorChar);
            return "doc";
          case '"':
          case "'":
            return yield* this.parseQuotedScalar();
          case "|":
          case ">":
            n += yield* this.parseBlockScalarHeader();
            n += yield* this.pushSpaces(true);
            yield* this.pushCount(line2.length - n);
            yield* this.pushNewline();
            return yield* this.parseBlockScalar();
          default:
            return yield* this.parsePlainScalar();
        }
      }
      *parseFlowCollection() {
        let nl, sp;
        let indent2 = -1;
        do {
          nl = yield* this.pushNewline();
          if (nl > 0) {
            sp = yield* this.pushSpaces(false);
            this.indentValue = indent2 = sp;
          } else {
            sp = 0;
          }
          sp += yield* this.pushSpaces(true);
        } while (nl + sp > 0);
        const line2 = this.getLine();
        if (line2 === null)
          return this.setNext("flow");
        if (indent2 !== -1 && indent2 < this.indentNext && line2[0] !== "#" || indent2 === 0 && (line2.startsWith("---") || line2.startsWith("...")) && isEmpty(line2[3])) {
          const atFlowEndMarker = indent2 === this.indentNext - 1 && this.flowLevel === 1 && (line2[0] === "]" || line2[0] === "}");
          if (!atFlowEndMarker) {
            this.flowLevel = 0;
            yield cst.FLOW_END;
            return yield* this.parseLineStart();
          }
        }
        let n = 0;
        while (line2[n] === ",") {
          n += yield* this.pushCount(1);
          n += yield* this.pushSpaces(true);
          this.flowKey = false;
        }
        n += yield* this.pushIndicators();
        switch (line2[n]) {
          case void 0:
            return "flow";
          case "#":
            yield* this.pushCount(line2.length - n);
            return "flow";
          case "{":
          case "[":
            yield* this.pushCount(1);
            this.flowKey = false;
            this.flowLevel += 1;
            return "flow";
          case "}":
          case "]":
            yield* this.pushCount(1);
            this.flowKey = true;
            this.flowLevel -= 1;
            return this.flowLevel ? "flow" : "doc";
          case "*":
            yield* this.pushUntil(isNotAnchorChar);
            return "flow";
          case '"':
          case "'":
            this.flowKey = true;
            return yield* this.parseQuotedScalar();
          case ":": {
            const next = this.charAt(1);
            if (this.flowKey || isEmpty(next) || next === ",") {
              this.flowKey = false;
              yield* this.pushCount(1);
              yield* this.pushSpaces(true);
              return "flow";
            }
          }
          // fallthrough
          default:
            this.flowKey = false;
            return yield* this.parsePlainScalar();
        }
      }
      *parseQuotedScalar() {
        const quote = this.charAt(0);
        let end2 = this.buffer.indexOf(quote, this.pos + 1);
        if (quote === "'") {
          while (end2 !== -1 && this.buffer[end2 + 1] === "'")
            end2 = this.buffer.indexOf("'", end2 + 2);
        } else {
          while (end2 !== -1) {
            let n = 0;
            while (this.buffer[end2 - 1 - n] === "\\")
              n += 1;
            if (n % 2 === 0)
              break;
            end2 = this.buffer.indexOf('"', end2 + 1);
          }
        }
        const qb = this.buffer.substring(0, end2);
        let nl = qb.indexOf("\n", this.pos);
        if (nl !== -1) {
          while (nl !== -1) {
            const cs = this.continueScalar(nl + 1);
            if (cs === -1)
              break;
            nl = qb.indexOf("\n", cs);
          }
          if (nl !== -1) {
            end2 = nl - (qb[nl - 1] === "\r" ? 2 : 1);
          }
        }
        if (end2 === -1) {
          if (!this.atEnd)
            return this.setNext("quoted-scalar");
          end2 = this.buffer.length;
        }
        yield* this.pushToIndex(end2 + 1, false);
        return this.flowLevel ? "flow" : "doc";
      }
      *parseBlockScalarHeader() {
        this.blockScalarIndent = -1;
        this.blockScalarKeep = false;
        let i = this.pos;
        while (true) {
          const ch = this.buffer[++i];
          if (ch === "+")
            this.blockScalarKeep = true;
          else if (ch > "0" && ch <= "9")
            this.blockScalarIndent = Number(ch) - 1;
          else if (ch !== "-")
            break;
        }
        return yield* this.pushUntil((ch) => isEmpty(ch) || ch === "#");
      }
      *parseBlockScalar() {
        let nl = this.pos - 1;
        let indent2 = 0;
        let ch;
        loop: for (let i2 = this.pos; ch = this.buffer[i2]; ++i2) {
          switch (ch) {
            case " ":
              indent2 += 1;
              break;
            case "\n":
              nl = i2;
              indent2 = 0;
              break;
            case "\r": {
              const next = this.buffer[i2 + 1];
              if (!next && !this.atEnd)
                return this.setNext("block-scalar");
              if (next === "\n")
                break;
            }
            // fallthrough
            default:
              break loop;
          }
        }
        if (!ch && !this.atEnd)
          return this.setNext("block-scalar");
        if (indent2 >= this.indentNext) {
          if (this.blockScalarIndent === -1)
            this.indentNext = indent2;
          else {
            this.indentNext = this.blockScalarIndent + (this.indentNext === 0 ? 1 : this.indentNext);
          }
          do {
            const cs = this.continueScalar(nl + 1);
            if (cs === -1)
              break;
            nl = this.buffer.indexOf("\n", cs);
          } while (nl !== -1);
          if (nl === -1) {
            if (!this.atEnd)
              return this.setNext("block-scalar");
            nl = this.buffer.length;
          }
        }
        let i = nl + 1;
        ch = this.buffer[i];
        while (ch === " ")
          ch = this.buffer[++i];
        if (ch === "	") {
          while (ch === "	" || ch === " " || ch === "\r" || ch === "\n")
            ch = this.buffer[++i];
          nl = i - 1;
        } else if (!this.blockScalarKeep) {
          do {
            let i2 = nl - 1;
            let ch2 = this.buffer[i2];
            if (ch2 === "\r")
              ch2 = this.buffer[--i2];
            const lastChar = i2;
            while (ch2 === " ")
              ch2 = this.buffer[--i2];
            if (ch2 === "\n" && i2 >= this.pos && i2 + 1 + indent2 > lastChar)
              nl = i2;
            else
              break;
          } while (true);
        }
        yield cst.SCALAR;
        yield* this.pushToIndex(nl + 1, true);
        return yield* this.parseLineStart();
      }
      *parsePlainScalar() {
        const inFlow = this.flowLevel > 0;
        let end2 = this.pos - 1;
        let i = this.pos - 1;
        let ch;
        while (ch = this.buffer[++i]) {
          if (ch === ":") {
            const next = this.buffer[i + 1];
            if (isEmpty(next) || inFlow && flowIndicatorChars.has(next))
              break;
            end2 = i;
          } else if (isEmpty(ch)) {
            let next = this.buffer[i + 1];
            if (ch === "\r") {
              if (next === "\n") {
                i += 1;
                ch = "\n";
                next = this.buffer[i + 1];
              } else
                end2 = i;
            }
            if (next === "#" || inFlow && flowIndicatorChars.has(next))
              break;
            if (ch === "\n") {
              const cs = this.continueScalar(i + 1);
              if (cs === -1)
                break;
              i = Math.max(i, cs - 2);
            }
          } else {
            if (inFlow && flowIndicatorChars.has(ch))
              break;
            end2 = i;
          }
        }
        if (!ch && !this.atEnd)
          return this.setNext("plain-scalar");
        yield cst.SCALAR;
        yield* this.pushToIndex(end2 + 1, true);
        return inFlow ? "flow" : "doc";
      }
      *pushCount(n) {
        if (n > 0) {
          yield this.buffer.substr(this.pos, n);
          this.pos += n;
          return n;
        }
        return 0;
      }
      *pushToIndex(i, allowEmpty) {
        const s = this.buffer.slice(this.pos, i);
        if (s) {
          yield s;
          this.pos += s.length;
          return s.length;
        } else if (allowEmpty)
          yield "";
        return 0;
      }
      *pushIndicators() {
        let n = 0;
        loop: while (true) {
          switch (this.charAt(0)) {
            case "!":
              n += yield* this.pushTag();
              n += yield* this.pushSpaces(true);
              continue loop;
            case "&":
              n += yield* this.pushUntil(isNotAnchorChar);
              n += yield* this.pushSpaces(true);
              continue loop;
            case "-":
            // this is an error
            case "?":
            // this is an error outside flow collections
            case ":": {
              const inFlow = this.flowLevel > 0;
              const ch1 = this.charAt(1);
              if (isEmpty(ch1) || inFlow && flowIndicatorChars.has(ch1)) {
                if (!inFlow)
                  this.indentNext = this.indentValue + 1;
                else if (this.flowKey)
                  this.flowKey = false;
                n += yield* this.pushCount(1);
                n += yield* this.pushSpaces(true);
                continue loop;
              }
            }
          }
          break loop;
        }
        return n;
      }
      *pushTag() {
        if (this.charAt(1) === "<") {
          let i = this.pos + 2;
          let ch = this.buffer[i];
          while (!isEmpty(ch) && ch !== ">")
            ch = this.buffer[++i];
          return yield* this.pushToIndex(ch === ">" ? i + 1 : i, false);
        } else {
          let i = this.pos + 1;
          let ch = this.buffer[i];
          while (ch) {
            if (tagChars.has(ch))
              ch = this.buffer[++i];
            else if (ch === "%" && hexDigits.has(this.buffer[i + 1]) && hexDigits.has(this.buffer[i + 2])) {
              ch = this.buffer[i += 3];
            } else
              break;
          }
          return yield* this.pushToIndex(i, false);
        }
      }
      *pushNewline() {
        const ch = this.buffer[this.pos];
        if (ch === "\n")
          return yield* this.pushCount(1);
        else if (ch === "\r" && this.charAt(1) === "\n")
          return yield* this.pushCount(2);
        else
          return 0;
      }
      *pushSpaces(allowTabs) {
        let i = this.pos - 1;
        let ch;
        do {
          ch = this.buffer[++i];
        } while (ch === " " || allowTabs && ch === "	");
        const n = i - this.pos;
        if (n > 0) {
          yield this.buffer.substr(this.pos, n);
          this.pos = i;
        }
        return n;
      }
      *pushUntil(test) {
        let i = this.pos;
        let ch = this.buffer[i];
        while (!test(ch))
          ch = this.buffer[++i];
        return yield* this.pushToIndex(i, false);
      }
    };
    exports.Lexer = Lexer;
  }
});

// node_modules/yaml/dist/parse/line-counter.js
var require_line_counter = __commonJS({
  "node_modules/yaml/dist/parse/line-counter.js"(exports) {
    "use strict";
    var LineCounter = class {
      constructor() {
        this.lineStarts = [];
        this.addNewLine = (offset) => this.lineStarts.push(offset);
        this.linePos = (offset) => {
          let low = 0;
          let high = this.lineStarts.length;
          while (low < high) {
            const mid = low + high >> 1;
            if (this.lineStarts[mid] < offset)
              low = mid + 1;
            else
              high = mid;
          }
          if (this.lineStarts[low] === offset)
            return { line: low + 1, col: 1 };
          if (low === 0)
            return { line: 0, col: offset };
          const start2 = this.lineStarts[low - 1];
          return { line: low, col: offset - start2 + 1 };
        };
      }
    };
    exports.LineCounter = LineCounter;
  }
});

// node_modules/yaml/dist/parse/parser.js
var require_parser = __commonJS({
  "node_modules/yaml/dist/parse/parser.js"(exports) {
    "use strict";
    var node_process = __require("process");
    var cst = require_cst();
    var lexer = require_lexer();
    function includesToken(list2, type) {
      for (let i = 0; i < list2.length; ++i)
        if (list2[i].type === type)
          return true;
      return false;
    }
    function findNonEmptyIndex(list2) {
      for (let i = 0; i < list2.length; ++i) {
        switch (list2[i].type) {
          case "space":
          case "comment":
          case "newline":
            break;
          default:
            return i;
        }
      }
      return -1;
    }
    function isFlowToken(token) {
      switch (token?.type) {
        case "alias":
        case "scalar":
        case "single-quoted-scalar":
        case "double-quoted-scalar":
        case "flow-collection":
          return true;
        default:
          return false;
      }
    }
    function getPrevProps(parent) {
      switch (parent.type) {
        case "document":
          return parent.start;
        case "block-map": {
          const it = parent.items[parent.items.length - 1];
          return it.sep ?? it.start;
        }
        case "block-seq":
          return parent.items[parent.items.length - 1].start;
        /* istanbul ignore next should not happen */
        default:
          return [];
      }
    }
    function getFirstKeyStartProps(prev) {
      if (prev.length === 0)
        return [];
      let i = prev.length;
      loop: while (--i >= 0) {
        switch (prev[i].type) {
          case "doc-start":
          case "explicit-key-ind":
          case "map-value-ind":
          case "seq-item-ind":
          case "newline":
            break loop;
        }
      }
      while (prev[++i]?.type === "space") {
      }
      return prev.splice(i, prev.length);
    }
    function arrayPushArray(target, source) {
      if (source.length < 1e5)
        Array.prototype.push.apply(target, source);
      else
        for (let i = 0; i < source.length; ++i)
          target.push(source[i]);
    }
    function fixFlowSeqItems(fc) {
      if (fc.start.type === "flow-seq-start") {
        for (const it of fc.items) {
          if (it.sep && !it.value && !includesToken(it.start, "explicit-key-ind") && !includesToken(it.sep, "map-value-ind")) {
            if (it.key)
              it.value = it.key;
            delete it.key;
            if (isFlowToken(it.value)) {
              if (it.value.end)
                arrayPushArray(it.value.end, it.sep);
              else
                it.value.end = it.sep;
            } else
              arrayPushArray(it.start, it.sep);
            delete it.sep;
          }
        }
      }
    }
    var Parser = class {
      /**
       * @param onNewLine - If defined, called separately with the start position of
       *   each new line (in `parse()`, including the start of input).
       */
      constructor(onNewLine) {
        this.atNewLine = true;
        this.atScalar = false;
        this.indent = 0;
        this.offset = 0;
        this.onKeyLine = false;
        this.stack = [];
        this.source = "";
        this.type = "";
        this.lexer = new lexer.Lexer();
        this.onNewLine = onNewLine;
      }
      /**
       * Parse `source` as a YAML stream.
       * If `incomplete`, a part of the last line may be left as a buffer for the next call.
       *
       * Errors are not thrown, but yielded as `{ type: 'error', message }` tokens.
       *
       * @returns A generator of tokens representing each directive, document, and other structure.
       */
      *parse(source, incomplete = false) {
        if (this.onNewLine && this.offset === 0)
          this.onNewLine(0);
        for (const lexeme of this.lexer.lex(source, incomplete))
          yield* this.next(lexeme);
        if (!incomplete)
          yield* this.end();
      }
      /**
       * Advance the parser by the `source` of one lexical token.
       */
      *next(source) {
        this.source = source;
        if (node_process.env.LOG_TOKENS)
          console.log("|", cst.prettyToken(source));
        if (this.atScalar) {
          this.atScalar = false;
          yield* this.step();
          this.offset += source.length;
          return;
        }
        const type = cst.tokenType(source);
        if (!type) {
          const message = `Not a YAML token: ${source}`;
          yield* this.pop({ type: "error", offset: this.offset, message, source });
          this.offset += source.length;
        } else if (type === "scalar") {
          this.atNewLine = false;
          this.atScalar = true;
          this.type = "scalar";
        } else {
          this.type = type;
          yield* this.step();
          switch (type) {
            case "newline":
              this.atNewLine = true;
              this.indent = 0;
              if (this.onNewLine)
                this.onNewLine(this.offset + source.length);
              break;
            case "space":
              if (this.atNewLine && source[0] === " ")
                this.indent += source.length;
              break;
            case "explicit-key-ind":
            case "map-value-ind":
            case "seq-item-ind":
              if (this.atNewLine)
                this.indent += source.length;
              break;
            case "doc-mode":
            case "flow-error-end":
              return;
            default:
              this.atNewLine = false;
          }
          this.offset += source.length;
        }
      }
      /** Call at end of input to push out any remaining constructions */
      *end() {
        while (this.stack.length > 0)
          yield* this.pop();
      }
      get sourceToken() {
        const st = {
          type: this.type,
          offset: this.offset,
          indent: this.indent,
          source: this.source
        };
        return st;
      }
      *step() {
        const top = this.peek(1);
        if (this.type === "doc-end" && top?.type !== "doc-end") {
          while (this.stack.length > 0)
            yield* this.pop();
          this.stack.push({
            type: "doc-end",
            offset: this.offset,
            source: this.source
          });
          return;
        }
        if (!top)
          return yield* this.stream();
        switch (top.type) {
          case "document":
            return yield* this.document(top);
          case "alias":
          case "scalar":
          case "single-quoted-scalar":
          case "double-quoted-scalar":
            return yield* this.scalar(top);
          case "block-scalar":
            return yield* this.blockScalar(top);
          case "block-map":
            return yield* this.blockMap(top);
          case "block-seq":
            return yield* this.blockSequence(top);
          case "flow-collection":
            return yield* this.flowCollection(top);
          case "doc-end":
            return yield* this.documentEnd(top);
        }
        yield* this.pop();
      }
      peek(n) {
        return this.stack[this.stack.length - n];
      }
      *pop(error) {
        const token = error ?? this.stack.pop();
        if (!token) {
          const message = "Tried to pop an empty stack";
          yield { type: "error", offset: this.offset, source: "", message };
        } else if (this.stack.length === 0) {
          yield token;
        } else {
          const top = this.peek(1);
          if (token.type === "block-scalar") {
            token.indent = "indent" in top ? top.indent : 0;
          } else if (token.type === "flow-collection" && top.type === "document") {
            token.indent = 0;
          }
          if (token.type === "flow-collection")
            fixFlowSeqItems(token);
          switch (top.type) {
            case "document":
              top.value = token;
              break;
            case "block-scalar":
              top.props.push(token);
              break;
            case "block-map": {
              const it = top.items[top.items.length - 1];
              if (it.value) {
                top.items.push({ start: [], key: token, sep: [] });
                this.onKeyLine = true;
                return;
              } else if (it.sep) {
                it.value = token;
              } else {
                Object.assign(it, { key: token, sep: [] });
                this.onKeyLine = !it.explicitKey;
                return;
              }
              break;
            }
            case "block-seq": {
              const it = top.items[top.items.length - 1];
              if (it.value)
                top.items.push({ start: [], value: token });
              else
                it.value = token;
              break;
            }
            case "flow-collection": {
              const it = top.items[top.items.length - 1];
              if (!it || it.value)
                top.items.push({ start: [], key: token, sep: [] });
              else if (it.sep)
                it.value = token;
              else
                Object.assign(it, { key: token, sep: [] });
              return;
            }
            /* istanbul ignore next should not happen */
            default:
              yield* this.pop();
              yield* this.pop(token);
          }
          if ((top.type === "document" || top.type === "block-map" || top.type === "block-seq") && (token.type === "block-map" || token.type === "block-seq")) {
            const last = token.items[token.items.length - 1];
            if (last && !last.sep && !last.value && last.start.length > 0 && findNonEmptyIndex(last.start) === -1 && (token.indent === 0 || last.start.every((st) => st.type !== "comment" || st.indent < token.indent))) {
              if (top.type === "document")
                top.end = last.start;
              else
                top.items.push({ start: last.start });
              token.items.splice(-1, 1);
            }
          }
        }
      }
      *stream() {
        switch (this.type) {
          case "directive-line":
            yield { type: "directive", offset: this.offset, source: this.source };
            return;
          case "byte-order-mark":
          case "space":
          case "comment":
          case "newline":
            yield this.sourceToken;
            return;
          case "doc-mode":
          case "doc-start": {
            const doc = {
              type: "document",
              offset: this.offset,
              start: []
            };
            if (this.type === "doc-start")
              doc.start.push(this.sourceToken);
            this.stack.push(doc);
            return;
          }
        }
        yield {
          type: "error",
          offset: this.offset,
          message: `Unexpected ${this.type} token in YAML stream`,
          source: this.source
        };
      }
      *document(doc) {
        if (doc.value)
          return yield* this.lineEnd(doc);
        switch (this.type) {
          case "doc-start": {
            if (findNonEmptyIndex(doc.start) !== -1) {
              yield* this.pop();
              yield* this.step();
            } else
              doc.start.push(this.sourceToken);
            return;
          }
          case "anchor":
          case "tag":
          case "space":
          case "comment":
          case "newline":
            doc.start.push(this.sourceToken);
            return;
        }
        const bv = this.startBlockValue(doc);
        if (bv)
          this.stack.push(bv);
        else {
          yield {
            type: "error",
            offset: this.offset,
            message: `Unexpected ${this.type} token in YAML document`,
            source: this.source
          };
        }
      }
      *scalar(scalar) {
        if (this.type === "map-value-ind") {
          const prev = getPrevProps(this.peek(2));
          const start2 = getFirstKeyStartProps(prev);
          let sep3;
          if (scalar.end) {
            sep3 = scalar.end;
            sep3.push(this.sourceToken);
            delete scalar.end;
          } else
            sep3 = [this.sourceToken];
          const map = {
            type: "block-map",
            offset: scalar.offset,
            indent: scalar.indent,
            items: [{ start: start2, key: scalar, sep: sep3 }]
          };
          this.onKeyLine = true;
          this.stack[this.stack.length - 1] = map;
        } else
          yield* this.lineEnd(scalar);
      }
      *blockScalar(scalar) {
        switch (this.type) {
          case "space":
          case "comment":
          case "newline":
            scalar.props.push(this.sourceToken);
            return;
          case "scalar":
            scalar.source = this.source;
            this.atNewLine = true;
            this.indent = 0;
            if (this.onNewLine) {
              let nl = this.source.indexOf("\n") + 1;
              while (nl !== 0) {
                this.onNewLine(this.offset + nl);
                nl = this.source.indexOf("\n", nl) + 1;
              }
            }
            yield* this.pop();
            break;
          /* istanbul ignore next should not happen */
          default:
            yield* this.pop();
            yield* this.step();
        }
      }
      *blockMap(map) {
        const it = map.items[map.items.length - 1];
        switch (this.type) {
          case "newline":
            this.onKeyLine = false;
            if (it.value) {
              const end2 = "end" in it.value ? it.value.end : void 0;
              const last = Array.isArray(end2) ? end2[end2.length - 1] : void 0;
              if (last?.type === "comment")
                end2?.push(this.sourceToken);
              else
                map.items.push({ start: [this.sourceToken] });
            } else if (it.sep) {
              it.sep.push(this.sourceToken);
            } else {
              it.start.push(this.sourceToken);
            }
            return;
          case "space":
          case "comment":
            if (it.value) {
              map.items.push({ start: [this.sourceToken] });
            } else if (it.sep) {
              it.sep.push(this.sourceToken);
            } else {
              if (this.atIndentedComment(it.start, map.indent)) {
                const prev = map.items[map.items.length - 2];
                const end2 = prev?.value?.end;
                if (Array.isArray(end2)) {
                  arrayPushArray(end2, it.start);
                  end2.push(this.sourceToken);
                  map.items.pop();
                  return;
                }
              }
              it.start.push(this.sourceToken);
            }
            return;
        }
        if (this.indent >= map.indent) {
          const atMapIndent = !this.onKeyLine && this.indent === map.indent;
          const atNextItem = atMapIndent && (it.sep || it.explicitKey) && this.type !== "seq-item-ind";
          let start2 = [];
          if (atNextItem && it.sep && !it.value) {
            const nl = [];
            for (let i = 0; i < it.sep.length; ++i) {
              const st = it.sep[i];
              switch (st.type) {
                case "newline":
                  nl.push(i);
                  break;
                case "space":
                  break;
                case "comment":
                  if (st.indent > map.indent)
                    nl.length = 0;
                  break;
                default:
                  nl.length = 0;
              }
            }
            if (nl.length >= 2)
              start2 = it.sep.splice(nl[1]);
          }
          switch (this.type) {
            case "anchor":
            case "tag":
              if (atNextItem || it.value) {
                start2.push(this.sourceToken);
                map.items.push({ start: start2 });
                this.onKeyLine = true;
              } else if (it.sep) {
                it.sep.push(this.sourceToken);
              } else {
                it.start.push(this.sourceToken);
              }
              return;
            case "explicit-key-ind":
              if (!it.sep && !it.explicitKey) {
                it.start.push(this.sourceToken);
                it.explicitKey = true;
              } else if (atNextItem || it.value) {
                start2.push(this.sourceToken);
                map.items.push({ start: start2, explicitKey: true });
              } else {
                this.stack.push({
                  type: "block-map",
                  offset: this.offset,
                  indent: this.indent,
                  items: [{ start: [this.sourceToken], explicitKey: true }]
                });
              }
              this.onKeyLine = true;
              return;
            case "map-value-ind":
              if (it.explicitKey) {
                if (!it.sep) {
                  if (includesToken(it.start, "newline")) {
                    Object.assign(it, { key: null, sep: [this.sourceToken] });
                  } else {
                    const start3 = getFirstKeyStartProps(it.start);
                    this.stack.push({
                      type: "block-map",
                      offset: this.offset,
                      indent: this.indent,
                      items: [{ start: start3, key: null, sep: [this.sourceToken] }]
                    });
                  }
                } else if (it.value) {
                  map.items.push({ start: [], key: null, sep: [this.sourceToken] });
                } else if (includesToken(it.sep, "map-value-ind")) {
                  this.stack.push({
                    type: "block-map",
                    offset: this.offset,
                    indent: this.indent,
                    items: [{ start: start2, key: null, sep: [this.sourceToken] }]
                  });
                } else if (isFlowToken(it.key) && !includesToken(it.sep, "newline")) {
                  const start3 = getFirstKeyStartProps(it.start);
                  const key = it.key;
                  const sep3 = it.sep;
                  sep3.push(this.sourceToken);
                  delete it.key;
                  delete it.sep;
                  this.stack.push({
                    type: "block-map",
                    offset: this.offset,
                    indent: this.indent,
                    items: [{ start: start3, key, sep: sep3 }]
                  });
                } else if (start2.length > 0) {
                  it.sep = it.sep.concat(start2, this.sourceToken);
                } else {
                  it.sep.push(this.sourceToken);
                }
              } else {
                if (!it.sep) {
                  Object.assign(it, { key: null, sep: [this.sourceToken] });
                } else if (it.value || atNextItem) {
                  map.items.push({ start: start2, key: null, sep: [this.sourceToken] });
                } else if (includesToken(it.sep, "map-value-ind")) {
                  this.stack.push({
                    type: "block-map",
                    offset: this.offset,
                    indent: this.indent,
                    items: [{ start: [], key: null, sep: [this.sourceToken] }]
                  });
                } else {
                  it.sep.push(this.sourceToken);
                }
              }
              this.onKeyLine = true;
              return;
            case "alias":
            case "scalar":
            case "single-quoted-scalar":
            case "double-quoted-scalar": {
              const fs = this.flowScalar(this.type);
              if (atNextItem || it.value) {
                map.items.push({ start: start2, key: fs, sep: [] });
                this.onKeyLine = true;
              } else if (it.sep) {
                this.stack.push(fs);
              } else {
                Object.assign(it, { key: fs, sep: [] });
                this.onKeyLine = true;
              }
              return;
            }
            default: {
              const bv = this.startBlockValue(map);
              if (bv) {
                if (bv.type === "block-seq") {
                  if (!it.explicitKey && it.sep && !includesToken(it.sep, "newline")) {
                    yield* this.pop({
                      type: "error",
                      offset: this.offset,
                      message: "Unexpected block-seq-ind on same line with key",
                      source: this.source
                    });
                    return;
                  }
                } else if (atMapIndent) {
                  map.items.push({ start: start2 });
                }
                this.stack.push(bv);
                return;
              }
            }
          }
        }
        yield* this.pop();
        yield* this.step();
      }
      *blockSequence(seq) {
        const it = seq.items[seq.items.length - 1];
        switch (this.type) {
          case "newline":
            if (it.value) {
              const end2 = "end" in it.value ? it.value.end : void 0;
              const last = Array.isArray(end2) ? end2[end2.length - 1] : void 0;
              if (last?.type === "comment")
                end2?.push(this.sourceToken);
              else
                seq.items.push({ start: [this.sourceToken] });
            } else
              it.start.push(this.sourceToken);
            return;
          case "space":
          case "comment":
            if (it.value)
              seq.items.push({ start: [this.sourceToken] });
            else {
              if (this.atIndentedComment(it.start, seq.indent)) {
                const prev = seq.items[seq.items.length - 2];
                const end2 = prev?.value?.end;
                if (Array.isArray(end2)) {
                  arrayPushArray(end2, it.start);
                  end2.push(this.sourceToken);
                  seq.items.pop();
                  return;
                }
              }
              it.start.push(this.sourceToken);
            }
            return;
          case "anchor":
          case "tag":
            if (it.value || this.indent <= seq.indent)
              break;
            it.start.push(this.sourceToken);
            return;
          case "seq-item-ind":
            if (this.indent !== seq.indent)
              break;
            if (it.value || includesToken(it.start, "seq-item-ind"))
              seq.items.push({ start: [this.sourceToken] });
            else
              it.start.push(this.sourceToken);
            return;
        }
        if (this.indent > seq.indent) {
          const bv = this.startBlockValue(seq);
          if (bv) {
            this.stack.push(bv);
            return;
          }
        }
        yield* this.pop();
        yield* this.step();
      }
      *flowCollection(fc) {
        const it = fc.items[fc.items.length - 1];
        if (this.type === "flow-error-end") {
          let top;
          do {
            yield* this.pop();
            top = this.peek(1);
          } while (top?.type === "flow-collection");
        } else if (fc.end.length === 0) {
          switch (this.type) {
            case "comma":
            case "explicit-key-ind":
              if (!it || it.sep)
                fc.items.push({ start: [this.sourceToken] });
              else
                it.start.push(this.sourceToken);
              return;
            case "map-value-ind":
              if (!it || it.value)
                fc.items.push({ start: [], key: null, sep: [this.sourceToken] });
              else if (it.sep)
                it.sep.push(this.sourceToken);
              else
                Object.assign(it, { key: null, sep: [this.sourceToken] });
              return;
            case "space":
            case "comment":
            case "newline":
            case "anchor":
            case "tag":
              if (!it || it.value)
                fc.items.push({ start: [this.sourceToken] });
              else if (it.sep)
                it.sep.push(this.sourceToken);
              else
                it.start.push(this.sourceToken);
              return;
            case "alias":
            case "scalar":
            case "single-quoted-scalar":
            case "double-quoted-scalar": {
              const fs = this.flowScalar(this.type);
              if (!it || it.value)
                fc.items.push({ start: [], key: fs, sep: [] });
              else if (it.sep)
                this.stack.push(fs);
              else
                Object.assign(it, { key: fs, sep: [] });
              return;
            }
            case "flow-map-end":
            case "flow-seq-end":
              fc.end.push(this.sourceToken);
              return;
          }
          const bv = this.startBlockValue(fc);
          if (bv)
            this.stack.push(bv);
          else {
            yield* this.pop();
            yield* this.step();
          }
        } else {
          const parent = this.peek(2);
          if (parent.type === "block-map" && (this.type === "map-value-ind" && parent.indent === fc.indent || this.type === "newline" && !parent.items[parent.items.length - 1].sep)) {
            yield* this.pop();
            yield* this.step();
          } else if (this.type === "map-value-ind" && parent.type !== "flow-collection") {
            const prev = getPrevProps(parent);
            const start2 = getFirstKeyStartProps(prev);
            fixFlowSeqItems(fc);
            const sep3 = fc.end.splice(1, fc.end.length);
            sep3.push(this.sourceToken);
            const map = {
              type: "block-map",
              offset: fc.offset,
              indent: fc.indent,
              items: [{ start: start2, key: fc, sep: sep3 }]
            };
            this.onKeyLine = true;
            this.stack[this.stack.length - 1] = map;
          } else {
            yield* this.lineEnd(fc);
          }
        }
      }
      flowScalar(type) {
        if (this.onNewLine) {
          let nl = this.source.indexOf("\n") + 1;
          while (nl !== 0) {
            this.onNewLine(this.offset + nl);
            nl = this.source.indexOf("\n", nl) + 1;
          }
        }
        return {
          type,
          offset: this.offset,
          indent: this.indent,
          source: this.source
        };
      }
      startBlockValue(parent) {
        switch (this.type) {
          case "alias":
          case "scalar":
          case "single-quoted-scalar":
          case "double-quoted-scalar":
            return this.flowScalar(this.type);
          case "block-scalar-header":
            return {
              type: "block-scalar",
              offset: this.offset,
              indent: this.indent,
              props: [this.sourceToken],
              source: ""
            };
          case "flow-map-start":
          case "flow-seq-start":
            return {
              type: "flow-collection",
              offset: this.offset,
              indent: this.indent,
              start: this.sourceToken,
              items: [],
              end: []
            };
          case "seq-item-ind":
            return {
              type: "block-seq",
              offset: this.offset,
              indent: this.indent,
              items: [{ start: [this.sourceToken] }]
            };
          case "explicit-key-ind": {
            this.onKeyLine = true;
            const prev = getPrevProps(parent);
            const start2 = getFirstKeyStartProps(prev);
            start2.push(this.sourceToken);
            return {
              type: "block-map",
              offset: this.offset,
              indent: this.indent,
              items: [{ start: start2, explicitKey: true }]
            };
          }
          case "map-value-ind": {
            this.onKeyLine = true;
            const prev = getPrevProps(parent);
            const start2 = getFirstKeyStartProps(prev);
            return {
              type: "block-map",
              offset: this.offset,
              indent: this.indent,
              items: [{ start: start2, key: null, sep: [this.sourceToken] }]
            };
          }
        }
        return null;
      }
      atIndentedComment(start2, indent2) {
        if (this.type !== "comment")
          return false;
        if (this.indent <= indent2)
          return false;
        return start2.every((st) => st.type === "newline" || st.type === "space");
      }
      *documentEnd(docEnd) {
        if (this.type !== "doc-mode") {
          if (docEnd.end)
            docEnd.end.push(this.sourceToken);
          else
            docEnd.end = [this.sourceToken];
          if (this.type === "newline")
            yield* this.pop();
        }
      }
      *lineEnd(token) {
        switch (this.type) {
          case "comma":
          case "doc-start":
          case "doc-end":
          case "flow-seq-end":
          case "flow-map-end":
          case "map-value-ind":
            yield* this.pop();
            yield* this.step();
            break;
          case "newline":
            this.onKeyLine = false;
          // fallthrough
          case "space":
          case "comment":
          default:
            if (token.end)
              token.end.push(this.sourceToken);
            else
              token.end = [this.sourceToken];
            if (this.type === "newline")
              yield* this.pop();
        }
      }
    };
    exports.Parser = Parser;
  }
});

// node_modules/yaml/dist/public-api.js
var require_public_api = __commonJS({
  "node_modules/yaml/dist/public-api.js"(exports) {
    "use strict";
    var composer = require_composer();
    var Document = require_Document();
    var errors = require_errors();
    var log = require_log();
    var identity = require_identity();
    var lineCounter = require_line_counter();
    var parser = require_parser();
    function parseOptions(options) {
      const prettyErrors = options.prettyErrors !== false;
      const lineCounter$1 = options.lineCounter || prettyErrors && new lineCounter.LineCounter() || null;
      return { lineCounter: lineCounter$1, prettyErrors };
    }
    function parseAllDocuments(source, options = {}) {
      const { lineCounter: lineCounter2, prettyErrors } = parseOptions(options);
      const parser$1 = new parser.Parser(lineCounter2?.addNewLine);
      const composer$1 = new composer.Composer(options);
      const docs = Array.from(composer$1.compose(parser$1.parse(source)));
      if (prettyErrors && lineCounter2)
        for (const doc of docs) {
          doc.errors.forEach(errors.prettifyError(source, lineCounter2));
          doc.warnings.forEach(errors.prettifyError(source, lineCounter2));
        }
      if (docs.length > 0)
        return docs;
      return Object.assign([], { empty: true }, composer$1.streamInfo());
    }
    function parseDocument3(source, options = {}) {
      const { lineCounter: lineCounter2, prettyErrors } = parseOptions(options);
      const parser$1 = new parser.Parser(lineCounter2?.addNewLine);
      const composer$1 = new composer.Composer(options);
      let doc = null;
      for (const _doc of composer$1.compose(parser$1.parse(source), true, source.length)) {
        if (!doc)
          doc = _doc;
        else if (doc.options.logLevel !== "silent") {
          doc.errors.push(new errors.YAMLParseError(_doc.range.slice(0, 2), "MULTIPLE_DOCS", "Source contains multiple documents; please use YAML.parseAllDocuments()"));
          break;
        }
      }
      if (prettyErrors && lineCounter2) {
        doc.errors.forEach(errors.prettifyError(source, lineCounter2));
        doc.warnings.forEach(errors.prettifyError(source, lineCounter2));
      }
      return doc;
    }
    function parse4(src, reviver, options) {
      let _reviver = void 0;
      if (typeof reviver === "function") {
        _reviver = reviver;
      } else if (options === void 0 && reviver && typeof reviver === "object") {
        options = reviver;
      }
      const doc = parseDocument3(src, options);
      if (!doc)
        return null;
      doc.warnings.forEach((warning) => log.warn(doc.options.logLevel, warning));
      if (doc.errors.length > 0) {
        if (doc.options.logLevel !== "silent")
          throw doc.errors[0];
        else
          doc.errors = [];
      }
      return doc.toJS(Object.assign({ reviver: _reviver }, options));
    }
    function stringify2(value, replacer, options) {
      let _replacer = null;
      if (typeof replacer === "function" || Array.isArray(replacer)) {
        _replacer = replacer;
      } else if (options === void 0 && replacer) {
        options = replacer;
      }
      if (typeof options === "string")
        options = options.length;
      if (typeof options === "number") {
        const indent2 = Math.round(options);
        options = indent2 < 1 ? void 0 : indent2 > 8 ? { indent: 8 } : { indent: indent2 };
      }
      if (value === void 0) {
        const { keepUndefined } = options ?? replacer ?? {};
        if (!keepUndefined)
          return void 0;
      }
      if (identity.isDocument(value) && !_replacer)
        return value.toString(options);
      return new Document.Document(value, _replacer, options).toString(options);
    }
    exports.parse = parse4;
    exports.parseAllDocuments = parseAllDocuments;
    exports.parseDocument = parseDocument3;
    exports.stringify = stringify2;
  }
});

// node_modules/yaml/dist/index.js
var require_dist = __commonJS({
  "node_modules/yaml/dist/index.js"(exports) {
    "use strict";
    var composer = require_composer();
    var Document = require_Document();
    var Schema = require_Schema();
    var errors = require_errors();
    var Alias = require_Alias();
    var identity = require_identity();
    var Pair = require_Pair();
    var Scalar = require_Scalar();
    var YAMLMap = require_YAMLMap();
    var YAMLSeq = require_YAMLSeq();
    var cst = require_cst();
    var lexer = require_lexer();
    var lineCounter = require_line_counter();
    var parser = require_parser();
    var publicApi = require_public_api();
    var visit2 = require_visit();
    exports.Composer = composer.Composer;
    exports.Document = Document.Document;
    exports.Schema = Schema.Schema;
    exports.YAMLError = errors.YAMLError;
    exports.YAMLParseError = errors.YAMLParseError;
    exports.YAMLWarning = errors.YAMLWarning;
    exports.Alias = Alias.Alias;
    exports.isAlias = identity.isAlias;
    exports.isCollection = identity.isCollection;
    exports.isDocument = identity.isDocument;
    exports.isMap = identity.isMap;
    exports.isNode = identity.isNode;
    exports.isPair = identity.isPair;
    exports.isScalar = identity.isScalar;
    exports.isSeq = identity.isSeq;
    exports.Pair = Pair.Pair;
    exports.Scalar = Scalar.Scalar;
    exports.YAMLMap = YAMLMap.YAMLMap;
    exports.YAMLSeq = YAMLSeq.YAMLSeq;
    exports.CST = cst;
    exports.Lexer = lexer.Lexer;
    exports.LineCounter = lineCounter.LineCounter;
    exports.Parser = parser.Parser;
    exports.parse = publicApi.parse;
    exports.parseAllDocuments = publicApi.parseAllDocuments;
    exports.parseDocument = publicApi.parseDocument;
    exports.stringify = publicApi.stringify;
    exports.visit = visit2.visit;
    exports.visitAsync = visit2.visitAsync;
  }
});

// src/cli.ts
import { createInterface } from "node:readline/promises";
import { appendFile } from "node:fs/promises";

// src/commands.ts
var COMMANDS = {
  sync: { summary: "Sync Markdown files and Linear documents both ways", notImplementedExitCode: 10 },
  "initial-sync": { summary: "Make one side match the other before the first sync", notImplementedExitCode: 11 },
  lint: { summary: "Report Markdown that Linear would change", notImplementedExitCode: 12 },
  fix: { summary: "Rewrite Markdown into the form Linear keeps", notImplementedExitCode: 13 },
  init: { summary: "Write the workflows and configuration into a repository", notImplementedExitCode: 14 },
  check: { summary: "Check the setup without changing Linear or the remote repository", notImplementedExitCode: 15 }
};
var PREFLIGHT_COMMANDS = ["sync", "initial-sync", "check"];
var USAGE_EXIT_CODE = 2;
var SETUP_FAILED_EXIT_CODE = 3;
var NO_STATE_EXIT_CODE = 4;
var INCOMPLETE_EXIT_CODE = 5;
function isCommandName(value) {
  return Object.hasOwn(COMMANDS, value);
}
function notImplementedMessage(command) {
  return `${command}: not implemented`;
}

// src/linear/errors.ts
var LinearError = class extends Error {
  operation;
  constructor(operation, message, options) {
    super(message, options);
    this.name = new.target.name;
    this.operation = operation;
  }
};
var LinearStoppedError = class extends LinearError {
  reason;
  constructor(operation, reason) {
    super(operation, `${operation}: Linear client stopped (${describeStop(reason)})`);
    this.reason = reason;
  }
};
var LinearGraphQLError = class extends LinearError {
  code;
  type;
  httpStatus;
  /** The referenced entity does not exist (for example a document removed from trash). */
  notFound;
  /** Linear's `x-request-id` of the answer. */
  requestId;
  constructor(operation, httpStatus, error, requestId) {
    const code2 = stringOrUndefined(error.extensions?.code);
    const type = stringOrUndefined(error.extensions?.type);
    super(
      operation,
      `${operation}: Linear error ${code2 ?? "unknown"} (HTTP ${httpStatus}, request ${requestId ?? "unknown"}): ${error.message ?? ""}`.trim()
    );
    this.code = code2;
    this.type = type;
    this.httpStatus = httpStatus;
    this.requestId = requestId;
    this.notFound = typeof error.message === "string" && error.message.startsWith("Entity not found");
  }
};
var LinearHttpError = class extends LinearError {
  httpStatus;
  requestId;
  constructor(operation, httpStatus, requestId) {
    super(operation, `${operation}: Linear answered HTTP ${httpStatus} (request ${requestId ?? "unknown"})`);
    this.httpStatus = httpStatus;
    this.requestId = requestId;
  }
};
var LinearNetworkError = class extends LinearError {
  constructor(operation, cause) {
    super(operation, `${operation}: request to Linear failed (${causeName(cause)})`, { cause });
  }
};
var LinearTokenError = class extends LinearError {
  /** Linear's HTTP status; undefined when the request did not complete. */
  httpStatus;
  constructor(operation, message, options) {
    super(operation, message, options);
    this.httpStatus = options?.httpStatus;
  }
  /** Linear answered and refused the client credentials, as opposed to an outage or a lost request. */
  get credentialsRefused() {
    return this.operation === "oauth.token" && (this.httpStatus === 400 || this.httpStatus === 401);
  }
};
var DocumentTooLongError = class extends LinearError {
  field;
  length;
  limit;
  constructor(operation, refusal) {
    super(operation, `${operation}: ${refusal.field} is ${refusal.length} characters, Linear accepts at most ${refusal.limit}`);
    this.field = refusal.field;
    this.length = refusal.length;
    this.limit = refusal.limit;
  }
};
var LinearReadBackError = class extends LinearError {
  document;
  constructor(operation, document4, cause) {
    super(operation, `${operation}: written, but reading back the stored record failed`, { cause });
    this.document = document4;
  }
};
var LinearUploadError = class extends LinearError {
};
function describeLinearError(error) {
  const code2 = error.code;
  const status = error.httpStatus;
  return [error.name, typeof code2 === "string" ? code2 : void 0, typeof status === "number" ? `HTTP ${status}` : void 0].filter(Boolean).join(" ");
}
function isTransientLinearError(error) {
  if (error instanceof LinearNetworkError) return true;
  const status = error.httpStatus;
  return typeof status === "number" && status >= 500;
}
function describeStop(reason) {
  if (reason.kind === "rate-limited") {
    return reason.retryAfterSeconds === void 0 ? "rate limited" : `rate limited, retry after ${reason.retryAfterSeconds} s`;
  }
  return `${reason.header} is ${reason.remaining}, below ${reason.threshold}`;
}
function stringOrUndefined(value) {
  return typeof value === "string" ? value : void 0;
}
function causeName(cause) {
  if (cause instanceof Error) {
    const code2 = cause.code ?? cause.cause?.code;
    return typeof code2 === "string" ? `${cause.name} ${code2}` : cause.name;
  }
  return "unknown error";
}

// src/linear/facts.ts
var LINEAR_FACTS = Object.freeze({
  mutationsReturnStoredContent: true,
  maxTitleLength: 512,
  maxContentLength: 25e4,
  teamFilterIncludesProjectDocuments: false
});
function linearLength(text4) {
  let length = 0;
  for (const _ of text4) length += 1;
  return length;
}
function lengthRefusal(document4, facts = LINEAR_FACTS) {
  const over = (text4, limit) => {
    if (text4 === void 0 || text4.length <= limit) return void 0;
    const length = linearLength(text4);
    return length > limit ? length : void 0;
  };
  const title = over(document4.title, facts.maxTitleLength);
  if (title !== void 0) return { field: "title", length: title, limit: facts.maxTitleLength };
  const content4 = over(document4.content, facts.maxContentLength);
  if (content4 !== void 0) return { field: "content", length: content4, limit: facts.maxContentLength };
  return void 0;
}

// src/linear/rate-limit.ts
var DEFAULT_BUDGET_FLOOR = {
  minRequestsRemaining: 100,
  minComplexityRemaining: 5e4,
  minEndpointRequestsRemaining: 5
};
function readRateLimitHeaders(headers) {
  const raw = {};
  for (const [name, value] of headers) {
    const key = name.toLowerCase();
    if (key.startsWith("x-ratelimit-") || key === "x-complexity") {
      raw[key] = value;
    }
  }
  const num = (key) => {
    const value = raw[key];
    if (value === void 0) return void 0;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : void 0;
  };
  return {
    requestsLimit: num("x-ratelimit-requests-limit"),
    requestsRemaining: num("x-ratelimit-requests-remaining"),
    requestsReset: num("x-ratelimit-requests-reset"),
    complexityLimit: num("x-ratelimit-complexity-limit"),
    complexityRemaining: num("x-ratelimit-complexity-remaining"),
    complexityReset: num("x-ratelimit-complexity-reset"),
    complexity: num("x-complexity"),
    endpointName: raw["x-ratelimit-endpoint-name"],
    endpointRequestsLimit: num("x-ratelimit-endpoint-requests-limit"),
    endpointRequestsRemaining: num("x-ratelimit-endpoint-requests-remaining"),
    endpointRequestsReset: num("x-ratelimit-endpoint-requests-reset"),
    headers: raw
  };
}
function findLowBudget(operation, snapshot, floor) {
  const checks = [
    ["x-ratelimit-requests-remaining", snapshot.requestsRemaining, floor.minRequestsRemaining],
    ["x-ratelimit-complexity-remaining", snapshot.complexityRemaining, floor.minComplexityRemaining],
    ["x-ratelimit-endpoint-requests-remaining", snapshot.endpointRequestsRemaining, floor.minEndpointRequestsRemaining]
  ];
  for (const [header, remaining, threshold] of checks) {
    if (remaining !== void 0 && remaining < threshold) {
      return { kind: "budget-low", operation, header, remaining, threshold, ...limitsOf(snapshot) };
    }
  }
  return void 0;
}
function parseRetryAfter(value, now = Date.now()) {
  if (value === null || value.trim() === "") return void 0;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds);
  const date = Date.parse(value);
  if (Number.isNaN(date)) return void 0;
  return Math.max(0, Math.ceil((date - now) / 1e3));
}
function limitsOf(snapshot) {
  return Object.keys(snapshot.headers).length === 0 ? {} : { limits: { ...snapshot.headers } };
}

// src/linear/diagnostics.ts
function authMetadata(context) {
  return context === void 0 ? void 0 : {
    grantType: context.grantType,
    requestedScopes: [...context.requestedScopes],
    returnedScopes: [...context.returnedScopes]
  };
}
function requestTiming(started) {
  const finished = Date.now();
  return {
    startedAt: new Date(started).toISOString(),
    finishedAt: new Date(finished).toISOString(),
    durationMs: finished - started
  };
}
function emitLog(log, entry) {
  try {
    void Promise.resolve(log?.(entry)).catch(() => {
    });
  } catch {
  }
}

// src/linear/stats.ts
var RequestStats = class {
  /** Requests sent to Linear's API, including retries and OAuth token calls. */
  total = 0;
  /** Requests per operation name. */
  byOperation = /* @__PURE__ */ new Map();
  /** Upload PUTs to file storage; these do not count against Linear's API budget. */
  storagePuts = 0;
  /** Writes the run tried after the client stopped; each was refused without a request. */
  writesAfterStop = 0;
  /**
   * Writes Linear accepted, by operation: a mutation once its answer reports
   * success, a file upload (`FileUpload`) once storage took its bytes. A
   * refused, failed or unanswered write is not counted.
   */
  writes = /* @__PURE__ */ new Map();
  count(operation) {
    this.total += 1;
    this.byOperation.set(operation, (this.byOperation.get(operation) ?? 0) + 1);
  }
  /** Counts a write Linear accepted. */
  wrote(operation) {
    this.writes.set(operation, (this.writes.get(operation) ?? 0) + 1);
  }
  toJSON() {
    return {
      total: this.total,
      storagePuts: this.storagePuts,
      writesAfterStop: this.writesAfterStop,
      byOperation: Object.fromEntries([...this.byOperation].sort(([a], [b]) => a.localeCompare(b)))
    };
  }
};

// src/linear/reads.ts
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
var VERSION = 2;
var INDEX = "index.json";
var BODIES = "bodies";
var sha256 = (data) => createHash("sha256").update(data).digest("hex");
var graphqlReadKey = (body2) => sha256(`graphql
${body2}`);
var uploadReadKey = (url) => sha256(`upload
${url}`);
var LinearReads = class _LinearReads {
  mode;
  /** Kept answers by key, each key's in the order they were kept. */
  #answers = /* @__PURE__ */ new Map();
  #order = [];
  #token = null;
  #ended = false;
  constructor(mode) {
    this.mode = mode;
  }
  /** The stage step: keeps every answer it is given. */
  static recording() {
    return new _LinearReads("record");
  }
  /**
   * The apply step: the stage step's record, or null when there is none it
   * can use (that step did not run, ran another version, or left the record
   * unfinished); the apply step then reads Linear itself.
   */
  static async replaying(folder) {
    try {
      const index2 = JSON.parse(await readFile(join(folder, INDEX), "utf8"));
      if (index2.version !== VERSION || index2.token === null || !Array.isArray(index2.answers)) return null;
      const reads = new _LinearReads("replay");
      reads.#token = index2.token;
      for (const { key, status, type, body: body2 } of index2.answers) {
        if (!/^[0-9a-f]{64}$/.test(body2)) return null;
        const bytes = await readFile(join(folder, BODIES, body2));
        if (sha256(bytes) !== body2) return null;
        reads.#add(key, { status, type, body: bytes });
      }
      return reads;
    } catch {
      return null;
    }
  }
  /** The stage step's token, as the apply step's setup check sees it; null while recording. */
  get token() {
    return this.mode === "replay" ? this.#token : null;
  }
  /** Records the scopes of the token the stage step reads with. */
  tokenMinted(scope, context) {
    if (this.mode === "record") this.#token = { scope: [...scope], context: authMetadata(context) };
  }
  /** The kept answer to this read, taken so it answers once; none while recording or after the capture ended. */
  take(key) {
    if (this.mode !== "replay" || this.#ended) return void 0;
    return this.#answers.get(key)?.shift();
  }
  /** Keeps a successful answer while recording. */
  keep(key, answer) {
    if (this.mode !== "record" || this.#ended || answer.status < 200 || answer.status >= 300) return;
    this.#add(key, answer);
  }
  /** The capture ended: nothing more is kept or answered. */
  end() {
    this.#ended = true;
  }
  /** Writes the record into `folder`, which only the job's own steps share. */
  async save(folder) {
    await mkdir(join(folder, BODIES), { recursive: true, mode: 448 });
    const index2 = { version: VERSION, token: this.#token, answers: [] };
    const queues = new Map([...this.#answers].map(([key, answers]) => [key, [...answers]]));
    for (const key of this.#order) {
      const answer = queues.get(key)?.shift();
      if (answer === void 0) continue;
      const body2 = sha256(answer.body);
      await writeFile(join(folder, BODIES, body2), answer.body, { mode: 384 });
      index2.answers.push({ key, status: answer.status, type: answer.type, body: body2 });
    }
    await writeFile(join(folder, INDEX), JSON.stringify(index2), { mode: 384 });
  }
  #add(key, answer) {
    const queue = this.#answers.get(key);
    if (queue === void 0) this.#answers.set(key, [answer]);
    else queue.push(answer);
    this.#order.push(key);
  }
};

// src/linear/transport.ts
var DEFAULT_BASE_URL = "https://api.linear.app";
var GraphQLTransport = class {
  stats;
  baseUrl;
  fetch;
  reads;
  #token;
  #auth;
  #floor;
  #maxRetryAfterSeconds;
  #timeoutMs;
  #hooks;
  #sleep;
  #stopped;
  #lastRateLimit;
  constructor(options) {
    this.#token = options.token;
    if (options.reads !== void 0) this.reads = options.reads;
    this.#auth = authMetadata(options.auth);
    this.baseUrl = trimSlash(options.baseUrl ?? DEFAULT_BASE_URL);
    this.#floor = { ...DEFAULT_BUDGET_FLOOR, ...options.budgetFloor };
    this.#maxRetryAfterSeconds = options.maxRetryAfterSeconds ?? 10;
    this.#timeoutMs = options.timeoutMs ?? 6e4;
    this.#hooks = options.hooks ?? {};
    this.stats = options.stats ?? new RequestStats();
    this.fetch = options.fetch ?? defaultFetch;
    this.#sleep = options.sleep ?? ((ms) => new Promise((resolve3) => setTimeout(resolve3, ms)));
  }
  /** Authenticated storage GET, restricted to Linear's documented upload host. */
  async fetchUpload(url, init = {}) {
    const target = new URL(url);
    if (target.protocol !== "https:" || target.hostname !== "uploads.linear.app" || target.username !== "" || target.password !== "" || target.port !== "") {
      throw new Error("upload destination is not allowed");
    }
    return this.fetch(url, { ...init, method: "GET", redirect: "manual", headers: { authorization: `Bearer ${await this.#accessToken()}` } });
  }
  #accessToken() {
    return typeof this.#token === "string" ? Promise.resolve(this.#token) : this.#token();
  }
  /** Why the client stopped, or undefined while it is running. */
  get stopped() {
    return this.#stopped;
  }
  /** Rate-limit headers of the latest response. */
  get lastRateLimit() {
    return this.#lastRateLimit;
  }
  async request(operation, kind, query, variables = {}) {
    const requestBody = JSON.stringify({ query, variables, operationName: operation });
    const key = this.reads !== void 0 && kind === "query" ? graphqlReadKey(requestBody) : void 0;
    for (let attempt = 1; ; attempt += 1) {
      if (this.#stopped) throw this.#refuse(operation, kind, this.#stopped);
      const kept = attempt === 1 && key !== void 0 ? this.reads?.take(key) : void 0;
      if (kept !== void 0) return keptData(operation, kept.status, kept.body);
      const info = { operation, kind, attempt };
      await this.#hooks.beforeRequest?.(info);
      if (this.#stopped) throw this.#refuse(operation, kind, this.#stopped);
      const token = await this.#accessToken();
      const started = Date.now();
      this.stats.count(operation);
      let response;
      try {
        response = await this.fetch(`${this.baseUrl}/graphql`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
          body: requestBody,
          signal: AbortSignal.timeout(this.#timeoutMs)
        });
      } catch (error) {
        this.#log({ ...info, ...authMetadata(this.#auth), ...requestTiming(started), status: "network-error", rateLimitHeaders: {} });
        throw new LinearNetworkError(operation, error);
      }
      const rateLimit = readRateLimitHeaders(response.headers);
      const requestId = response.headers.get("x-request-id") ?? void 0;
      const durationMs = Date.now() - started;
      if (Object.keys(rateLimit.headers).length > 0) this.#lastRateLimit = rateLimit;
      try {
        await this.#hooks.afterResponse?.({ ...info, status: response.status, durationMs, rateLimit });
      } catch (error) {
        await response.body?.cancel().catch(() => {
        });
        this.#log({
          ...info,
          ...authMetadata(this.#auth),
          ...requestTiming(started),
          status: response.status,
          requestId,
          rateLimitHeaders: rateLimit.headers,
          responseHookFailed: true,
          ...error instanceof LinearStoppedError ? { stop: error.reason } : {}
        });
        throw error;
      }
      let body2;
      let text4 = "";
      let bodyError;
      try {
        text4 = await response.text();
        body2 = JSON.parse(text4);
      } catch (error) {
        body2 = void 0;
        bodyError = error;
      }
      const errorCodes = body2?.errors?.map((error) => String(error.extensions?.code ?? "unknown"));
      const entry = {
        ...info,
        ...authMetadata(this.#auth),
        ...requestTiming(started),
        status: response.status,
        rateLimitHeaders: rateLimit.headers,
        ...requestId === void 0 ? {} : { requestId },
        ...errorCodes === void 0 ? {} : { errorCodes }
      };
      if (isRateLimited(response.status, body2?.errors)) {
        const retryAfterSeconds = parseRetryAfter(response.headers.get("retry-after"));
        const shortWait = retryAfterSeconds !== void 0 && retryAfterSeconds <= this.#maxRetryAfterSeconds;
        if (attempt === 1 && shortWait && !findLowBudget(operation, rateLimit, this.#floor)) {
          this.#log({ ...entry, retryAfterSeconds });
          await this.#sleep(retryAfterSeconds * 1e3);
          continue;
        }
        this.#stopped = { kind: "rate-limited", operation, retryAfterSeconds, ...limitsOf(rateLimit) };
        this.#log({ ...entry, retryAfterSeconds, stop: this.#stopped });
        throw new LinearStoppedError(operation, this.#stopped);
      }
      const low = findLowBudget(operation, rateLimit, this.#floor);
      if (low) this.#stopped = low;
      this.#log(low ? { ...entry, stop: low } : entry);
      const firstError = body2?.errors?.[0];
      if (firstError) throw new LinearGraphQLError(operation, response.status, firstError, requestId);
      if (response.ok && body2 === void 0) throw new LinearNetworkError(operation, bodyError);
      if (!response.ok || body2 === void 0 || body2.data === void 0 || body2.data === null) {
        throw new LinearHttpError(operation, response.status, requestId);
      }
      if (key !== void 0) this.reads?.keep(key, { status: response.status, type: "application/json", body: Buffer.from(text4, "utf8") });
      return body2.data;
    }
  }
  /** A request after the stop is refused without being sent; a refused write is counted, so a run can show it stopped writing. */
  #refuse(operation, kind, reason) {
    if (kind === "mutation") this.stats.writesAfterStop += 1;
    return new LinearStoppedError(operation, reason);
  }
  #log(entry) {
    emitLog(this.#hooks.log, entry);
  }
};
function keptData(operation, status, bytes) {
  let body2;
  try {
    body2 = JSON.parse(bytes.toString("utf8"));
  } catch {
    body2 = void 0;
  }
  const errors = body2?.errors;
  if (body2 === void 0 || body2 === null || (Array.isArray(errors) ? errors.length > 0 : errors !== void 0) || body2.data === void 0 || body2.data === null) {
    throw new LinearHttpError(operation, status, void 0);
  }
  return body2.data;
}
function isRateLimited(status, errors) {
  return status === 429 || (errors ?? []).some((error) => error.extensions?.code === "RATELIMITED");
}
var defaultFetch = (input, init) => globalThis.fetch(input, init);
function trimSlash(url) {
  return url.replace(/\/+$/, "");
}

// src/linear/client.ts
var MAX_PAGE_SIZE = 250;
var DEFAULT_PAGE_SIZE = MAX_PAGE_SIZE;
var UPLOAD_TIMEOUT_MS = 12e4;
var DOCUMENT_FIELDS = `
  id title slugId icon color trashed archivedAt createdAt updatedAt documentContentId
  content @include(if: $withContent)
  project { id }
  team { id }`;
var LinearClient = class {
  transport;
  /** What the client assumes about Linear; the measured `LINEAR_FACTS` unless a test or the probe sets others. */
  facts;
  constructor(options, facts = LINEAR_FACTS) {
    this.transport = options instanceof GraphQLTransport ? options : new GraphQLTransport(options);
    this.facts = facts;
  }
  get stats() {
    return this.transport.stats;
  }
  /** Why the client stopped, or undefined while it runs. */
  get stopped() {
    return this.transport.stopped;
  }
  /** Sends any GraphQL document; for setup checks and tests. */
  request(operation, kind, query, variables) {
    return this.transport.request(operation, kind, query, variables);
  }
  async rateLimitStatus() {
    const data = await this.request(
      "RateLimitStatus",
      "query",
      `query RateLimitStatus {
        rateLimitStatus { identifier kind limits { type allowedAmount remainingAmount requestedAmount period reset } }
      }`
    );
    return data.rateLimitStatus;
  }
  /**
   * Lists every document of a project, or of a team zone (the team's
   * documents outside projects), page by page. Trashed documents are listed
   * only with `includeArchived`, then with `trashed` and `archivedAt` set.
   */
  async listDocuments(place, options = {}) {
    if (place.projectId !== void 0) {
      return this.#pagedDocuments("ListDocuments", { project: { id: { eq: place.projectId } } }, options);
    }
    const documents = await this.#pagedDocuments("ListDocuments", { team: { id: { eq: place.teamId } } }, options);
    return documents.filter((d) => d.projectId === null);
  }
  /** Lists mapped places together, using the same pagination and document parser. */
  async listDocumentsInPlaces(places, options = {}) {
    if (places.length === 0) return [];
    const filters = places.map((place) => place.projectId !== void 0 ? { project: { id: { eq: place.projectId } } } : { team: { id: { eq: place.teamId } } });
    const documents = await this.#pagedDocuments("ListDocuments", { or: filters }, options);
    return documents.filter((doc) => places.some((place) => place.projectId !== void 0 ? doc.projectId === place.projectId : doc.projectId === null && doc.teamId === place.teamId));
  }
  /**
   * Reads documents by id, one request per page of ids (one request for up
   * to `pageSize` ids). Trashed documents are included; ids that no longer
   * exist are absent from the result.
   */
  async getDocuments(ids, options = {}) {
    const pageSize = clampPageSize(options.pageSize);
    const result = [];
    for (let start2 = 0; start2 < ids.length; start2 += pageSize) {
      const chunk = ids.slice(start2, start2 + pageSize);
      const data = await this.request(
        "GetDocuments",
        "query",
        `query GetDocuments($ids: [ID!]!, $first: Int!, $withContent: Boolean!) {
          documents(first: $first, includeArchived: true, filter: { id: { in: $ids } }) {
            nodes { ${DOCUMENT_FIELDS} }
          }
        }`,
        { ids: chunk, first: chunk.length, withContent: options.withContent ?? false }
      );
      result.push(...data.documents.nodes.map(toDocument));
    }
    return result;
  }
  /**
   * Reads one document by id with `document(id:)`, which answers for trashed
   * and archived documents too; null when Linear no longer has the id.
   */
  async getDocument(id) {
    try {
      const data = await this.request(
        "GetDocument",
        "query",
        `query GetDocument($id: String!, $withContent: Boolean!) {
          document(id: $id) { ${DOCUMENT_FIELDS} }
        }`,
        { id, withContent: false }
      );
      return data.document === null ? null : toDocument(data.document);
    } catch (error) {
      if (error instanceof LinearGraphQLError && error.notFound) return null;
      throw error;
    }
  }
  /**
   * Creates a document and returns its record with the stored content. A
   * title or content longer than Linear accepts throws `DocumentTooLongError`
   * without a request. When `facts.mutationsReturnStoredContent` holds (as
   * measured), the payload is the stored record and this is one request;
   * otherwise a second request reads the document back. A failed read-back
   * throws `LinearReadBackError`: the document was created.
   */
  async createDocument(place, input) {
    this.#refuseTooLong("CreateDocument", input);
    const data = await this.request(
      "CreateDocument",
      "mutation",
      `mutation CreateDocument($input: DocumentCreateInput!, $withContent: Boolean!) {
        documentCreate(input: $input) { success document { ${DOCUMENT_FIELDS} } }
      }`,
      { input: { ...input, ...place }, withContent: true }
    );
    const created = toDocument(succeeded("CreateDocument", data.documentCreate).document);
    this.stats.wrote("CreateDocument");
    return this.#storedRecord("CreateDocument", created);
  }
  /**
   * Updates a document: content, rename (title), move (projectId or teamId),
   * icon and color. Like `createDocument`, refuses a too-long title or
   * content without a request and returns the stored content of a content
   * change: one request as measured, two when the facts call for a read-back.
   */
  async updateDocument(id, patch) {
    this.#refuseTooLong("UpdateDocument", patch);
    const data = await this.request(
      "UpdateDocument",
      "mutation",
      `mutation UpdateDocument($id: String!, $input: DocumentUpdateInput!, $withContent: Boolean!) {
        documentUpdate(id: $id, input: $input) { success document { ${DOCUMENT_FIELDS} } }
      }`,
      { id, input: patch, withContent: patch.content !== void 0 }
    );
    const updated = toDocument(succeeded("UpdateDocument", data.documentUpdate).document);
    this.stats.wrote("UpdateDocument");
    return patch.content === void 0 ? updated : this.#storedRecord("UpdateDocument", updated);
  }
  /** Moves a document to trash; it can be restored. Never deletes for good. */
  async trashDocument(id) {
    const data = await this.request(
      "TrashDocument",
      "mutation",
      `mutation TrashDocument($id: String!) { documentDelete(id: $id) { success } }`,
      { id }
    );
    succeeded("TrashDocument", data.documentDelete);
    this.stats.wrote("TrashDocument");
  }
  async restoreDocument(id) {
    const data = await this.request(
      "RestoreDocument",
      "mutation",
      `mutation RestoreDocument($id: String!) { documentUnarchive(id: $id) { success } }`,
      { id }
    );
    succeeded("RestoreDocument", data.documentUnarchive);
    this.stats.wrote("RestoreDocument");
  }
  /** Comments on a document; `documentContentId` comes from the document. */
  async commentOnDocument(documentContentId, body2, id) {
    const data = await this.request(
      "CommentOnDocument",
      "mutation",
      `mutation CommentOnDocument($input: CommentCreateInput!) {
        commentCreate(input: $input) { success comment { id } }
      }`,
      { input: { documentContentId, body: body2, ...id === void 0 ? {} : { id } } }
    );
    const comment = succeeded("CommentOnDocument", data.commentCreate).comment;
    this.stats.wrote("CommentOnDocument");
    return comment;
  }
  /** Update a previously posted notice without adding another comment. */
  async updateDocumentComment(id, body2) {
    const data = await this.request(
      "UpdateDocumentComment",
      "mutation",
      `mutation UpdateDocumentComment($id: String!, $input: CommentUpdateInput!) {
        commentUpdate(id: $id, input: $input) { success comment { id } }
      }`,
      { id, input: { body: body2 } }
    );
    const comment = succeeded("UpdateDocumentComment", data.commentUpdate).comment;
    this.stats.wrote("UpdateDocumentComment");
    return comment;
  }
  /** Ensure one notice exists, including recovery after a lost create response. */
  async ensureDocumentComment(documentContentId, body2, id, updateExisting = false) {
    const find = async () => {
      const data = await this.request(
        "FindDocumentComment",
        "query",
        `query FindDocumentComment($id: ID!) {
          comments(first: 1, includeArchived: true, filter: { id: { eq: $id } }) { nodes { id documentContentId } }
        }`,
        { id }
      );
      const comment2 = data.comments.nodes[0];
      if (!comment2) return false;
      if (comment2.id !== id || comment2.documentContentId !== documentContentId) {
        throw new LinearError("FindDocumentComment", "Comment identity does not match its document");
      }
      return true;
    };
    const existing = async () => {
      if (updateExisting) {
        const comment2 = await this.updateDocumentComment(id, body2);
        if (comment2.id !== id) throw new LinearError("UpdateDocumentComment", "Updated comment identity does not match");
      }
      return { id, created: false };
    };
    if (await find()) return existing();
    let comment;
    try {
      comment = await this.commentOnDocument(documentContentId, body2, id);
    } catch (error) {
      if (error instanceof LinearError && this.stopped === void 0) {
        let found = false;
        try {
          found = await find();
        } catch {
        }
        if (found) {
          const lost = error instanceof LinearNetworkError || (error instanceof LinearHttpError || error instanceof LinearGraphQLError) && error.httpStatus >= 500;
          if (lost) this.stats.wrote("CommentOnDocument");
          return existing();
        }
      }
      throw error;
    }
    if (comment.id !== id) throw new LinearError("CommentOnDocument", "Created comment identity does not match");
    return { id, created: true };
  }
  /**
   * Uploads a file: `fileUpload` returns a signed storage URL, the bytes go
   * there with one PUT, and the returned asset URL is what documents embed.
   * Measured: Linear issues an upload target for a declared 10 MiB and for
   * 10 MiB + 1 byte, and refuses a declared 100 MiB (INPUT_ERROR).
   */
  async uploadFile(input) {
    const data = await this.request(
      "FileUpload",
      "mutation",
      `mutation FileUpload($contentType: String!, $filename: String!, $size: Int!) {
        fileUpload(contentType: $contentType, filename: $filename, size: $size) {
          success uploadFile { uploadUrl assetUrl headers { key value } }
        }
      }`,
      { contentType: input.contentType, filename: input.filename, size: input.bytes.byteLength }
    );
    const target = succeeded("FileUpload", data.fileUpload).uploadFile;
    if (!target) throw new LinearUploadError("FileUpload", "FileUpload: Linear returned no upload target");
    await this.#putUpload("FileUpload.put", target, input);
    return { assetUrl: target.assetUrl };
  }
  /**
   * Uploads several files with one API request: one `fileUpload` per file,
   * aliased in a single mutation, then one storage PUT per file. Linear's
   * request budget is the scarce one (5,000 an hour); each `fileUpload`
   * still counts against the complexity budget. Returns the asset URLs in
   * the order of `inputs`; throws when any file fails, after uploading the
   * ones before it (their URLs are lost to the caller, which uploads them
   * again one by one).
   */
  async uploadFiles(inputs) {
    if (inputs.length === 0) return [];
    const declarations = inputs.map((_, index2) => `$contentType${index2}: String!, $filename${index2}: String!, $size${index2}: Int!`).join(", ");
    const fields = inputs.map((_, index2) => `f${index2}: fileUpload(contentType: $contentType${index2}, filename: $filename${index2}, size: $size${index2}) {
          success uploadFile { uploadUrl assetUrl headers { key value } }
        }`).join("\n        ");
    const variables = {};
    inputs.forEach((input, index2) => {
      variables[`contentType${index2}`] = input.contentType;
      variables[`filename${index2}`] = input.filename;
      variables[`size${index2}`] = input.bytes.byteLength;
    });
    const data = await this.request("FileUploads", "mutation", `mutation FileUploads(${declarations}) {
        ${fields}
      }`, variables);
    const targets = inputs.map((_, index2) => {
      const payload = data[`f${index2}`];
      const target = payload === void 0 ? null : succeeded("FileUploads", payload).uploadFile;
      if (!target) throw new LinearUploadError("FileUploads", "FileUploads: Linear returned no upload target");
      return target;
    });
    const result = [];
    for (const [index2, input] of inputs.entries()) {
      const target = targets[index2];
      await this.#putUpload("FileUploads.put", target, input);
      result.push({ assetUrl: target.assetUrl });
    }
    return result;
  }
  /** Sends a file's bytes to the storage URL Linear issued for it. */
  async #putUpload(operation, target, input) {
    const headers = new Headers({ "content-type": input.contentType, "cache-control": "public, max-age=31536000" });
    for (const { key, value } of target.headers) headers.set(key, value);
    this.stats.storagePuts += 1;
    let response;
    try {
      response = await this.transport.fetch(target.uploadUrl, {
        method: "PUT",
        headers,
        body: input.bytes,
        signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS)
      });
    } catch (error) {
      throw new LinearUploadError(operation, `${operation}: storage request failed`, { cause: error });
    }
    if (!response.ok) {
      throw new LinearUploadError(operation, `${operation}: storage answered HTTP ${response.status}`);
    }
    this.stats.wrote("FileUpload");
  }
  #refuseTooLong(operation, document4) {
    const refusal = lengthRefusal(document4, this.facts);
    if (refusal) throw new DocumentTooLongError(operation, refusal);
  }
  /** The written document's record with its stored content: the payload, or a read-back when the payload may differ. */
  async #storedRecord(operation, written) {
    if (this.facts.mutationsReturnStoredContent) return written;
    let stored;
    try {
      [stored] = await this.getDocuments([written.id], { withContent: true });
    } catch (error) {
      if (error instanceof LinearStoppedError || !(error instanceof LinearError)) throw error;
      throw new LinearReadBackError(operation, written, error);
    }
    if (!stored) throw new LinearReadBackError(operation, written);
    return stored;
  }
  async #pagedDocuments(operation, filter, options) {
    const result = [];
    let after = null;
    do {
      const data = await this.request(
        operation,
        "query",
        `query ${operation}($filter: DocumentFilter, $first: Int!, $after: String, $includeArchived: Boolean!, $withContent: Boolean!) {
          documents(filter: $filter, first: $first, after: $after, includeArchived: $includeArchived, orderBy: createdAt) {
            nodes { ${DOCUMENT_FIELDS} }
            pageInfo { hasNextPage endCursor }
          }
        }`,
        {
          filter,
          first: clampPageSize(options.pageSize),
          after,
          includeArchived: options.includeArchived ?? false,
          withContent: options.withContent ?? false
        }
      );
      result.push(...data.documents.nodes.map(toDocument));
      const { hasNextPage, endCursor } = data.documents.pageInfo;
      if (hasNextPage && endCursor === null) {
        throw new LinearError(operation, `${operation}: Linear reported another page without a cursor`);
      }
      after = hasNextPage ? endCursor : null;
    } while (after !== null);
    return result;
  }
};
function succeeded(operation, payload) {
  if (payload.success !== true) throw new LinearError(operation, `${operation}: Linear reported success: false`);
  return payload;
}
function toDocument(raw) {
  const { project, team, trashed, ...rest } = raw;
  return { ...rest, projectId: project?.id ?? null, teamId: team?.id ?? null, trashed: trashed === true };
}
function clampPageSize(pageSize) {
  return Math.max(1, Math.min(MAX_PAGE_SIZE, Math.floor(pageSize ?? DEFAULT_PAGE_SIZE)));
}

// src/linear/token.ts
async function mintAppToken(credentials, options = {}) {
  const requestedScopes = credentials.scopes ?? ["read", "write"];
  const body2 = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: credentials.clientId,
    client_secret: credentials.clientSecret,
    scope: requestedScopes.join(",")
  });
  const { response, json } = await oauthPost("oauth.token", "/oauth/token", body2, options, requestedScopes);
  if (!response.ok || typeof json.access_token !== "string") {
    const reason = oauthErrorCode(json.error) ?? `HTTP ${response.status}`;
    throw new LinearTokenError("oauth.token", `oauth.token: Linear refused the token request (${reason})`, { httpStatus: response.status });
  }
  const scope = readScopes(json.scope);
  return {
    accessToken: json.access_token,
    expiresIn: typeof json.expires_in === "number" ? json.expires_in : 0,
    scope,
    context: { grantType: "client_credentials", requestedScopes: [...requestedScopes], returnedScopes: [...scope] }
  };
}
async function revokeToken(accessToken, options = {}) {
  const { response, json } = await oauthPost("oauth.revoke", "/oauth/revoke", new URLSearchParams({ token: accessToken }), options);
  if (!response.ok || json.success === false) {
    throw new LinearTokenError("oauth.revoke", `oauth.revoke: Linear did not confirm the revocation (HTTP ${response.status})`, {
      httpStatus: response.status
    });
  }
}
async function withRunToken(credentials, options, work) {
  const token = await mintAppToken(credentials, options);
  try {
    options.lifecycle?.minted(token.accessToken);
    return await work(token);
  } finally {
    await endRunToken(token, options);
  }
}
async function endRunToken(token, options) {
  let revoked = false;
  try {
    await revokeToken(token.accessToken, { ...options, auth: token.context });
    revoked = true;
  } catch (revokeError) {
    options.onRevokeError(revokeError);
  }
  if (revoked) {
    try {
      options.lifecycle?.revoked();
    } catch {
    }
  }
}
async function withDeferredRunToken(credentials, known, options, work) {
  let minting;
  let access;
  const token = {
    scope: [...known.scope],
    context: known.context,
    accessToken() {
      if (access === void 0) {
        const mint = mintAppToken(credentials, options);
        minting = mint;
        access = mint.then((minted) => {
          options.lifecycle?.minted(minted.accessToken);
          return minted.accessToken;
        });
      }
      return access;
    }
  };
  try {
    return await work(token);
  } finally {
    const minted = minting === void 0 ? void 0 : await minting.catch(() => void 0);
    if (minted !== void 0) await endRunToken(minted, options);
  }
}
async function oauthPost(operation, path2, body2, options, requestedScopes) {
  const fetchImpl = options.fetch ?? defaultFetch;
  const started = Date.now();
  const info = {
    operation,
    kind: "oauth",
    attempt: 1,
    ...requestedScopes ? { grantType: "client_credentials", requestedScopes: [...requestedScopes] } : authMetadata(options.auth)
  };
  options.stats?.count(operation);
  let response;
  try {
    response = await fetchImpl(`${trimSlash(options.baseUrl ?? DEFAULT_BASE_URL)}${path2}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body2,
      signal: AbortSignal.timeout(options.timeoutMs ?? 3e4)
    });
  } catch (error) {
    emitLog(options.hooks?.log, { ...info, ...requestTiming(started), status: "network-error", rateLimitHeaders: {} });
    throw new LinearTokenError(operation, `${operation}: request to Linear failed`, { cause: error });
  }
  const json = await readJson(response);
  emitLog(options.hooks?.log, {
    ...info,
    ...requestTiming(started),
    status: response.status,
    ...requestedScopes ? { returnedScopes: readScopes(json.scope) } : {},
    requestId: response.headers.get("x-request-id") ?? void 0,
    errorCodes: json.error === void 0 ? [] : [oauthErrorCode(json.error) ?? "unknown"],
    ...operation === "oauth.revoke" ? { revocationConfirmed: response.ok && json.success !== false } : {},
    rateLimitHeaders: readRateLimitHeaders(response.headers).headers
  });
  return { response, json };
}
function oauthErrorCode(error) {
  return typeof error === "string" && [
    "invalid_request",
    "invalid_client",
    "invalid_grant",
    "unauthorized_client",
    "unsupported_grant_type",
    "invalid_scope",
    "access_denied",
    "server_error",
    "temporarily_unavailable",
    "Error"
  ].includes(error) ? error : void 0;
}
function readScopes(scope) {
  return Array.isArray(scope) ? scope.filter((s) => typeof s === "string") : typeof scope === "string" ? scope.split(/[ ,]+/).filter(Boolean) : [];
}
async function readJson(response) {
  try {
    const json = await response.json();
    return json !== null && typeof json === "object" ? json : {};
  } catch {
    return {};
  }
}

// src/format/command.ts
import { existsSync, lstatSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join as join2, relative, resolve, sep } from "node:path";

// node_modules/character-entities/index.js
var characterEntities = {
  AElig: "\xC6",
  AMP: "&",
  Aacute: "\xC1",
  Abreve: "\u0102",
  Acirc: "\xC2",
  Acy: "\u0410",
  Afr: "\u{1D504}",
  Agrave: "\xC0",
  Alpha: "\u0391",
  Amacr: "\u0100",
  And: "\u2A53",
  Aogon: "\u0104",
  Aopf: "\u{1D538}",
  ApplyFunction: "\u2061",
  Aring: "\xC5",
  Ascr: "\u{1D49C}",
  Assign: "\u2254",
  Atilde: "\xC3",
  Auml: "\xC4",
  Backslash: "\u2216",
  Barv: "\u2AE7",
  Barwed: "\u2306",
  Bcy: "\u0411",
  Because: "\u2235",
  Bernoullis: "\u212C",
  Beta: "\u0392",
  Bfr: "\u{1D505}",
  Bopf: "\u{1D539}",
  Breve: "\u02D8",
  Bscr: "\u212C",
  Bumpeq: "\u224E",
  CHcy: "\u0427",
  COPY: "\xA9",
  Cacute: "\u0106",
  Cap: "\u22D2",
  CapitalDifferentialD: "\u2145",
  Cayleys: "\u212D",
  Ccaron: "\u010C",
  Ccedil: "\xC7",
  Ccirc: "\u0108",
  Cconint: "\u2230",
  Cdot: "\u010A",
  Cedilla: "\xB8",
  CenterDot: "\xB7",
  Cfr: "\u212D",
  Chi: "\u03A7",
  CircleDot: "\u2299",
  CircleMinus: "\u2296",
  CirclePlus: "\u2295",
  CircleTimes: "\u2297",
  ClockwiseContourIntegral: "\u2232",
  CloseCurlyDoubleQuote: "\u201D",
  CloseCurlyQuote: "\u2019",
  Colon: "\u2237",
  Colone: "\u2A74",
  Congruent: "\u2261",
  Conint: "\u222F",
  ContourIntegral: "\u222E",
  Copf: "\u2102",
  Coproduct: "\u2210",
  CounterClockwiseContourIntegral: "\u2233",
  Cross: "\u2A2F",
  Cscr: "\u{1D49E}",
  Cup: "\u22D3",
  CupCap: "\u224D",
  DD: "\u2145",
  DDotrahd: "\u2911",
  DJcy: "\u0402",
  DScy: "\u0405",
  DZcy: "\u040F",
  Dagger: "\u2021",
  Darr: "\u21A1",
  Dashv: "\u2AE4",
  Dcaron: "\u010E",
  Dcy: "\u0414",
  Del: "\u2207",
  Delta: "\u0394",
  Dfr: "\u{1D507}",
  DiacriticalAcute: "\xB4",
  DiacriticalDot: "\u02D9",
  DiacriticalDoubleAcute: "\u02DD",
  DiacriticalGrave: "`",
  DiacriticalTilde: "\u02DC",
  Diamond: "\u22C4",
  DifferentialD: "\u2146",
  Dopf: "\u{1D53B}",
  Dot: "\xA8",
  DotDot: "\u20DC",
  DotEqual: "\u2250",
  DoubleContourIntegral: "\u222F",
  DoubleDot: "\xA8",
  DoubleDownArrow: "\u21D3",
  DoubleLeftArrow: "\u21D0",
  DoubleLeftRightArrow: "\u21D4",
  DoubleLeftTee: "\u2AE4",
  DoubleLongLeftArrow: "\u27F8",
  DoubleLongLeftRightArrow: "\u27FA",
  DoubleLongRightArrow: "\u27F9",
  DoubleRightArrow: "\u21D2",
  DoubleRightTee: "\u22A8",
  DoubleUpArrow: "\u21D1",
  DoubleUpDownArrow: "\u21D5",
  DoubleVerticalBar: "\u2225",
  DownArrow: "\u2193",
  DownArrowBar: "\u2913",
  DownArrowUpArrow: "\u21F5",
  DownBreve: "\u0311",
  DownLeftRightVector: "\u2950",
  DownLeftTeeVector: "\u295E",
  DownLeftVector: "\u21BD",
  DownLeftVectorBar: "\u2956",
  DownRightTeeVector: "\u295F",
  DownRightVector: "\u21C1",
  DownRightVectorBar: "\u2957",
  DownTee: "\u22A4",
  DownTeeArrow: "\u21A7",
  Downarrow: "\u21D3",
  Dscr: "\u{1D49F}",
  Dstrok: "\u0110",
  ENG: "\u014A",
  ETH: "\xD0",
  Eacute: "\xC9",
  Ecaron: "\u011A",
  Ecirc: "\xCA",
  Ecy: "\u042D",
  Edot: "\u0116",
  Efr: "\u{1D508}",
  Egrave: "\xC8",
  Element: "\u2208",
  Emacr: "\u0112",
  EmptySmallSquare: "\u25FB",
  EmptyVerySmallSquare: "\u25AB",
  Eogon: "\u0118",
  Eopf: "\u{1D53C}",
  Epsilon: "\u0395",
  Equal: "\u2A75",
  EqualTilde: "\u2242",
  Equilibrium: "\u21CC",
  Escr: "\u2130",
  Esim: "\u2A73",
  Eta: "\u0397",
  Euml: "\xCB",
  Exists: "\u2203",
  ExponentialE: "\u2147",
  Fcy: "\u0424",
  Ffr: "\u{1D509}",
  FilledSmallSquare: "\u25FC",
  FilledVerySmallSquare: "\u25AA",
  Fopf: "\u{1D53D}",
  ForAll: "\u2200",
  Fouriertrf: "\u2131",
  Fscr: "\u2131",
  GJcy: "\u0403",
  GT: ">",
  Gamma: "\u0393",
  Gammad: "\u03DC",
  Gbreve: "\u011E",
  Gcedil: "\u0122",
  Gcirc: "\u011C",
  Gcy: "\u0413",
  Gdot: "\u0120",
  Gfr: "\u{1D50A}",
  Gg: "\u22D9",
  Gopf: "\u{1D53E}",
  GreaterEqual: "\u2265",
  GreaterEqualLess: "\u22DB",
  GreaterFullEqual: "\u2267",
  GreaterGreater: "\u2AA2",
  GreaterLess: "\u2277",
  GreaterSlantEqual: "\u2A7E",
  GreaterTilde: "\u2273",
  Gscr: "\u{1D4A2}",
  Gt: "\u226B",
  HARDcy: "\u042A",
  Hacek: "\u02C7",
  Hat: "^",
  Hcirc: "\u0124",
  Hfr: "\u210C",
  HilbertSpace: "\u210B",
  Hopf: "\u210D",
  HorizontalLine: "\u2500",
  Hscr: "\u210B",
  Hstrok: "\u0126",
  HumpDownHump: "\u224E",
  HumpEqual: "\u224F",
  IEcy: "\u0415",
  IJlig: "\u0132",
  IOcy: "\u0401",
  Iacute: "\xCD",
  Icirc: "\xCE",
  Icy: "\u0418",
  Idot: "\u0130",
  Ifr: "\u2111",
  Igrave: "\xCC",
  Im: "\u2111",
  Imacr: "\u012A",
  ImaginaryI: "\u2148",
  Implies: "\u21D2",
  Int: "\u222C",
  Integral: "\u222B",
  Intersection: "\u22C2",
  InvisibleComma: "\u2063",
  InvisibleTimes: "\u2062",
  Iogon: "\u012E",
  Iopf: "\u{1D540}",
  Iota: "\u0399",
  Iscr: "\u2110",
  Itilde: "\u0128",
  Iukcy: "\u0406",
  Iuml: "\xCF",
  Jcirc: "\u0134",
  Jcy: "\u0419",
  Jfr: "\u{1D50D}",
  Jopf: "\u{1D541}",
  Jscr: "\u{1D4A5}",
  Jsercy: "\u0408",
  Jukcy: "\u0404",
  KHcy: "\u0425",
  KJcy: "\u040C",
  Kappa: "\u039A",
  Kcedil: "\u0136",
  Kcy: "\u041A",
  Kfr: "\u{1D50E}",
  Kopf: "\u{1D542}",
  Kscr: "\u{1D4A6}",
  LJcy: "\u0409",
  LT: "<",
  Lacute: "\u0139",
  Lambda: "\u039B",
  Lang: "\u27EA",
  Laplacetrf: "\u2112",
  Larr: "\u219E",
  Lcaron: "\u013D",
  Lcedil: "\u013B",
  Lcy: "\u041B",
  LeftAngleBracket: "\u27E8",
  LeftArrow: "\u2190",
  LeftArrowBar: "\u21E4",
  LeftArrowRightArrow: "\u21C6",
  LeftCeiling: "\u2308",
  LeftDoubleBracket: "\u27E6",
  LeftDownTeeVector: "\u2961",
  LeftDownVector: "\u21C3",
  LeftDownVectorBar: "\u2959",
  LeftFloor: "\u230A",
  LeftRightArrow: "\u2194",
  LeftRightVector: "\u294E",
  LeftTee: "\u22A3",
  LeftTeeArrow: "\u21A4",
  LeftTeeVector: "\u295A",
  LeftTriangle: "\u22B2",
  LeftTriangleBar: "\u29CF",
  LeftTriangleEqual: "\u22B4",
  LeftUpDownVector: "\u2951",
  LeftUpTeeVector: "\u2960",
  LeftUpVector: "\u21BF",
  LeftUpVectorBar: "\u2958",
  LeftVector: "\u21BC",
  LeftVectorBar: "\u2952",
  Leftarrow: "\u21D0",
  Leftrightarrow: "\u21D4",
  LessEqualGreater: "\u22DA",
  LessFullEqual: "\u2266",
  LessGreater: "\u2276",
  LessLess: "\u2AA1",
  LessSlantEqual: "\u2A7D",
  LessTilde: "\u2272",
  Lfr: "\u{1D50F}",
  Ll: "\u22D8",
  Lleftarrow: "\u21DA",
  Lmidot: "\u013F",
  LongLeftArrow: "\u27F5",
  LongLeftRightArrow: "\u27F7",
  LongRightArrow: "\u27F6",
  Longleftarrow: "\u27F8",
  Longleftrightarrow: "\u27FA",
  Longrightarrow: "\u27F9",
  Lopf: "\u{1D543}",
  LowerLeftArrow: "\u2199",
  LowerRightArrow: "\u2198",
  Lscr: "\u2112",
  Lsh: "\u21B0",
  Lstrok: "\u0141",
  Lt: "\u226A",
  Map: "\u2905",
  Mcy: "\u041C",
  MediumSpace: "\u205F",
  Mellintrf: "\u2133",
  Mfr: "\u{1D510}",
  MinusPlus: "\u2213",
  Mopf: "\u{1D544}",
  Mscr: "\u2133",
  Mu: "\u039C",
  NJcy: "\u040A",
  Nacute: "\u0143",
  Ncaron: "\u0147",
  Ncedil: "\u0145",
  Ncy: "\u041D",
  NegativeMediumSpace: "\u200B",
  NegativeThickSpace: "\u200B",
  NegativeThinSpace: "\u200B",
  NegativeVeryThinSpace: "\u200B",
  NestedGreaterGreater: "\u226B",
  NestedLessLess: "\u226A",
  NewLine: "\n",
  Nfr: "\u{1D511}",
  NoBreak: "\u2060",
  NonBreakingSpace: "\xA0",
  Nopf: "\u2115",
  Not: "\u2AEC",
  NotCongruent: "\u2262",
  NotCupCap: "\u226D",
  NotDoubleVerticalBar: "\u2226",
  NotElement: "\u2209",
  NotEqual: "\u2260",
  NotEqualTilde: "\u2242\u0338",
  NotExists: "\u2204",
  NotGreater: "\u226F",
  NotGreaterEqual: "\u2271",
  NotGreaterFullEqual: "\u2267\u0338",
  NotGreaterGreater: "\u226B\u0338",
  NotGreaterLess: "\u2279",
  NotGreaterSlantEqual: "\u2A7E\u0338",
  NotGreaterTilde: "\u2275",
  NotHumpDownHump: "\u224E\u0338",
  NotHumpEqual: "\u224F\u0338",
  NotLeftTriangle: "\u22EA",
  NotLeftTriangleBar: "\u29CF\u0338",
  NotLeftTriangleEqual: "\u22EC",
  NotLess: "\u226E",
  NotLessEqual: "\u2270",
  NotLessGreater: "\u2278",
  NotLessLess: "\u226A\u0338",
  NotLessSlantEqual: "\u2A7D\u0338",
  NotLessTilde: "\u2274",
  NotNestedGreaterGreater: "\u2AA2\u0338",
  NotNestedLessLess: "\u2AA1\u0338",
  NotPrecedes: "\u2280",
  NotPrecedesEqual: "\u2AAF\u0338",
  NotPrecedesSlantEqual: "\u22E0",
  NotReverseElement: "\u220C",
  NotRightTriangle: "\u22EB",
  NotRightTriangleBar: "\u29D0\u0338",
  NotRightTriangleEqual: "\u22ED",
  NotSquareSubset: "\u228F\u0338",
  NotSquareSubsetEqual: "\u22E2",
  NotSquareSuperset: "\u2290\u0338",
  NotSquareSupersetEqual: "\u22E3",
  NotSubset: "\u2282\u20D2",
  NotSubsetEqual: "\u2288",
  NotSucceeds: "\u2281",
  NotSucceedsEqual: "\u2AB0\u0338",
  NotSucceedsSlantEqual: "\u22E1",
  NotSucceedsTilde: "\u227F\u0338",
  NotSuperset: "\u2283\u20D2",
  NotSupersetEqual: "\u2289",
  NotTilde: "\u2241",
  NotTildeEqual: "\u2244",
  NotTildeFullEqual: "\u2247",
  NotTildeTilde: "\u2249",
  NotVerticalBar: "\u2224",
  Nscr: "\u{1D4A9}",
  Ntilde: "\xD1",
  Nu: "\u039D",
  OElig: "\u0152",
  Oacute: "\xD3",
  Ocirc: "\xD4",
  Ocy: "\u041E",
  Odblac: "\u0150",
  Ofr: "\u{1D512}",
  Ograve: "\xD2",
  Omacr: "\u014C",
  Omega: "\u03A9",
  Omicron: "\u039F",
  Oopf: "\u{1D546}",
  OpenCurlyDoubleQuote: "\u201C",
  OpenCurlyQuote: "\u2018",
  Or: "\u2A54",
  Oscr: "\u{1D4AA}",
  Oslash: "\xD8",
  Otilde: "\xD5",
  Otimes: "\u2A37",
  Ouml: "\xD6",
  OverBar: "\u203E",
  OverBrace: "\u23DE",
  OverBracket: "\u23B4",
  OverParenthesis: "\u23DC",
  PartialD: "\u2202",
  Pcy: "\u041F",
  Pfr: "\u{1D513}",
  Phi: "\u03A6",
  Pi: "\u03A0",
  PlusMinus: "\xB1",
  Poincareplane: "\u210C",
  Popf: "\u2119",
  Pr: "\u2ABB",
  Precedes: "\u227A",
  PrecedesEqual: "\u2AAF",
  PrecedesSlantEqual: "\u227C",
  PrecedesTilde: "\u227E",
  Prime: "\u2033",
  Product: "\u220F",
  Proportion: "\u2237",
  Proportional: "\u221D",
  Pscr: "\u{1D4AB}",
  Psi: "\u03A8",
  QUOT: '"',
  Qfr: "\u{1D514}",
  Qopf: "\u211A",
  Qscr: "\u{1D4AC}",
  RBarr: "\u2910",
  REG: "\xAE",
  Racute: "\u0154",
  Rang: "\u27EB",
  Rarr: "\u21A0",
  Rarrtl: "\u2916",
  Rcaron: "\u0158",
  Rcedil: "\u0156",
  Rcy: "\u0420",
  Re: "\u211C",
  ReverseElement: "\u220B",
  ReverseEquilibrium: "\u21CB",
  ReverseUpEquilibrium: "\u296F",
  Rfr: "\u211C",
  Rho: "\u03A1",
  RightAngleBracket: "\u27E9",
  RightArrow: "\u2192",
  RightArrowBar: "\u21E5",
  RightArrowLeftArrow: "\u21C4",
  RightCeiling: "\u2309",
  RightDoubleBracket: "\u27E7",
  RightDownTeeVector: "\u295D",
  RightDownVector: "\u21C2",
  RightDownVectorBar: "\u2955",
  RightFloor: "\u230B",
  RightTee: "\u22A2",
  RightTeeArrow: "\u21A6",
  RightTeeVector: "\u295B",
  RightTriangle: "\u22B3",
  RightTriangleBar: "\u29D0",
  RightTriangleEqual: "\u22B5",
  RightUpDownVector: "\u294F",
  RightUpTeeVector: "\u295C",
  RightUpVector: "\u21BE",
  RightUpVectorBar: "\u2954",
  RightVector: "\u21C0",
  RightVectorBar: "\u2953",
  Rightarrow: "\u21D2",
  Ropf: "\u211D",
  RoundImplies: "\u2970",
  Rrightarrow: "\u21DB",
  Rscr: "\u211B",
  Rsh: "\u21B1",
  RuleDelayed: "\u29F4",
  SHCHcy: "\u0429",
  SHcy: "\u0428",
  SOFTcy: "\u042C",
  Sacute: "\u015A",
  Sc: "\u2ABC",
  Scaron: "\u0160",
  Scedil: "\u015E",
  Scirc: "\u015C",
  Scy: "\u0421",
  Sfr: "\u{1D516}",
  ShortDownArrow: "\u2193",
  ShortLeftArrow: "\u2190",
  ShortRightArrow: "\u2192",
  ShortUpArrow: "\u2191",
  Sigma: "\u03A3",
  SmallCircle: "\u2218",
  Sopf: "\u{1D54A}",
  Sqrt: "\u221A",
  Square: "\u25A1",
  SquareIntersection: "\u2293",
  SquareSubset: "\u228F",
  SquareSubsetEqual: "\u2291",
  SquareSuperset: "\u2290",
  SquareSupersetEqual: "\u2292",
  SquareUnion: "\u2294",
  Sscr: "\u{1D4AE}",
  Star: "\u22C6",
  Sub: "\u22D0",
  Subset: "\u22D0",
  SubsetEqual: "\u2286",
  Succeeds: "\u227B",
  SucceedsEqual: "\u2AB0",
  SucceedsSlantEqual: "\u227D",
  SucceedsTilde: "\u227F",
  SuchThat: "\u220B",
  Sum: "\u2211",
  Sup: "\u22D1",
  Superset: "\u2283",
  SupersetEqual: "\u2287",
  Supset: "\u22D1",
  THORN: "\xDE",
  TRADE: "\u2122",
  TSHcy: "\u040B",
  TScy: "\u0426",
  Tab: "	",
  Tau: "\u03A4",
  Tcaron: "\u0164",
  Tcedil: "\u0162",
  Tcy: "\u0422",
  Tfr: "\u{1D517}",
  Therefore: "\u2234",
  Theta: "\u0398",
  ThickSpace: "\u205F\u200A",
  ThinSpace: "\u2009",
  Tilde: "\u223C",
  TildeEqual: "\u2243",
  TildeFullEqual: "\u2245",
  TildeTilde: "\u2248",
  Topf: "\u{1D54B}",
  TripleDot: "\u20DB",
  Tscr: "\u{1D4AF}",
  Tstrok: "\u0166",
  Uacute: "\xDA",
  Uarr: "\u219F",
  Uarrocir: "\u2949",
  Ubrcy: "\u040E",
  Ubreve: "\u016C",
  Ucirc: "\xDB",
  Ucy: "\u0423",
  Udblac: "\u0170",
  Ufr: "\u{1D518}",
  Ugrave: "\xD9",
  Umacr: "\u016A",
  UnderBar: "_",
  UnderBrace: "\u23DF",
  UnderBracket: "\u23B5",
  UnderParenthesis: "\u23DD",
  Union: "\u22C3",
  UnionPlus: "\u228E",
  Uogon: "\u0172",
  Uopf: "\u{1D54C}",
  UpArrow: "\u2191",
  UpArrowBar: "\u2912",
  UpArrowDownArrow: "\u21C5",
  UpDownArrow: "\u2195",
  UpEquilibrium: "\u296E",
  UpTee: "\u22A5",
  UpTeeArrow: "\u21A5",
  Uparrow: "\u21D1",
  Updownarrow: "\u21D5",
  UpperLeftArrow: "\u2196",
  UpperRightArrow: "\u2197",
  Upsi: "\u03D2",
  Upsilon: "\u03A5",
  Uring: "\u016E",
  Uscr: "\u{1D4B0}",
  Utilde: "\u0168",
  Uuml: "\xDC",
  VDash: "\u22AB",
  Vbar: "\u2AEB",
  Vcy: "\u0412",
  Vdash: "\u22A9",
  Vdashl: "\u2AE6",
  Vee: "\u22C1",
  Verbar: "\u2016",
  Vert: "\u2016",
  VerticalBar: "\u2223",
  VerticalLine: "|",
  VerticalSeparator: "\u2758",
  VerticalTilde: "\u2240",
  VeryThinSpace: "\u200A",
  Vfr: "\u{1D519}",
  Vopf: "\u{1D54D}",
  Vscr: "\u{1D4B1}",
  Vvdash: "\u22AA",
  Wcirc: "\u0174",
  Wedge: "\u22C0",
  Wfr: "\u{1D51A}",
  Wopf: "\u{1D54E}",
  Wscr: "\u{1D4B2}",
  Xfr: "\u{1D51B}",
  Xi: "\u039E",
  Xopf: "\u{1D54F}",
  Xscr: "\u{1D4B3}",
  YAcy: "\u042F",
  YIcy: "\u0407",
  YUcy: "\u042E",
  Yacute: "\xDD",
  Ycirc: "\u0176",
  Ycy: "\u042B",
  Yfr: "\u{1D51C}",
  Yopf: "\u{1D550}",
  Yscr: "\u{1D4B4}",
  Yuml: "\u0178",
  ZHcy: "\u0416",
  Zacute: "\u0179",
  Zcaron: "\u017D",
  Zcy: "\u0417",
  Zdot: "\u017B",
  ZeroWidthSpace: "\u200B",
  Zeta: "\u0396",
  Zfr: "\u2128",
  Zopf: "\u2124",
  Zscr: "\u{1D4B5}",
  aacute: "\xE1",
  abreve: "\u0103",
  ac: "\u223E",
  acE: "\u223E\u0333",
  acd: "\u223F",
  acirc: "\xE2",
  acute: "\xB4",
  acy: "\u0430",
  aelig: "\xE6",
  af: "\u2061",
  afr: "\u{1D51E}",
  agrave: "\xE0",
  alefsym: "\u2135",
  aleph: "\u2135",
  alpha: "\u03B1",
  amacr: "\u0101",
  amalg: "\u2A3F",
  amp: "&",
  and: "\u2227",
  andand: "\u2A55",
  andd: "\u2A5C",
  andslope: "\u2A58",
  andv: "\u2A5A",
  ang: "\u2220",
  ange: "\u29A4",
  angle: "\u2220",
  angmsd: "\u2221",
  angmsdaa: "\u29A8",
  angmsdab: "\u29A9",
  angmsdac: "\u29AA",
  angmsdad: "\u29AB",
  angmsdae: "\u29AC",
  angmsdaf: "\u29AD",
  angmsdag: "\u29AE",
  angmsdah: "\u29AF",
  angrt: "\u221F",
  angrtvb: "\u22BE",
  angrtvbd: "\u299D",
  angsph: "\u2222",
  angst: "\xC5",
  angzarr: "\u237C",
  aogon: "\u0105",
  aopf: "\u{1D552}",
  ap: "\u2248",
  apE: "\u2A70",
  apacir: "\u2A6F",
  ape: "\u224A",
  apid: "\u224B",
  apos: "'",
  approx: "\u2248",
  approxeq: "\u224A",
  aring: "\xE5",
  ascr: "\u{1D4B6}",
  ast: "*",
  asymp: "\u2248",
  asympeq: "\u224D",
  atilde: "\xE3",
  auml: "\xE4",
  awconint: "\u2233",
  awint: "\u2A11",
  bNot: "\u2AED",
  backcong: "\u224C",
  backepsilon: "\u03F6",
  backprime: "\u2035",
  backsim: "\u223D",
  backsimeq: "\u22CD",
  barvee: "\u22BD",
  barwed: "\u2305",
  barwedge: "\u2305",
  bbrk: "\u23B5",
  bbrktbrk: "\u23B6",
  bcong: "\u224C",
  bcy: "\u0431",
  bdquo: "\u201E",
  becaus: "\u2235",
  because: "\u2235",
  bemptyv: "\u29B0",
  bepsi: "\u03F6",
  bernou: "\u212C",
  beta: "\u03B2",
  beth: "\u2136",
  between: "\u226C",
  bfr: "\u{1D51F}",
  bigcap: "\u22C2",
  bigcirc: "\u25EF",
  bigcup: "\u22C3",
  bigodot: "\u2A00",
  bigoplus: "\u2A01",
  bigotimes: "\u2A02",
  bigsqcup: "\u2A06",
  bigstar: "\u2605",
  bigtriangledown: "\u25BD",
  bigtriangleup: "\u25B3",
  biguplus: "\u2A04",
  bigvee: "\u22C1",
  bigwedge: "\u22C0",
  bkarow: "\u290D",
  blacklozenge: "\u29EB",
  blacksquare: "\u25AA",
  blacktriangle: "\u25B4",
  blacktriangledown: "\u25BE",
  blacktriangleleft: "\u25C2",
  blacktriangleright: "\u25B8",
  blank: "\u2423",
  blk12: "\u2592",
  blk14: "\u2591",
  blk34: "\u2593",
  block: "\u2588",
  bne: "=\u20E5",
  bnequiv: "\u2261\u20E5",
  bnot: "\u2310",
  bopf: "\u{1D553}",
  bot: "\u22A5",
  bottom: "\u22A5",
  bowtie: "\u22C8",
  boxDL: "\u2557",
  boxDR: "\u2554",
  boxDl: "\u2556",
  boxDr: "\u2553",
  boxH: "\u2550",
  boxHD: "\u2566",
  boxHU: "\u2569",
  boxHd: "\u2564",
  boxHu: "\u2567",
  boxUL: "\u255D",
  boxUR: "\u255A",
  boxUl: "\u255C",
  boxUr: "\u2559",
  boxV: "\u2551",
  boxVH: "\u256C",
  boxVL: "\u2563",
  boxVR: "\u2560",
  boxVh: "\u256B",
  boxVl: "\u2562",
  boxVr: "\u255F",
  boxbox: "\u29C9",
  boxdL: "\u2555",
  boxdR: "\u2552",
  boxdl: "\u2510",
  boxdr: "\u250C",
  boxh: "\u2500",
  boxhD: "\u2565",
  boxhU: "\u2568",
  boxhd: "\u252C",
  boxhu: "\u2534",
  boxminus: "\u229F",
  boxplus: "\u229E",
  boxtimes: "\u22A0",
  boxuL: "\u255B",
  boxuR: "\u2558",
  boxul: "\u2518",
  boxur: "\u2514",
  boxv: "\u2502",
  boxvH: "\u256A",
  boxvL: "\u2561",
  boxvR: "\u255E",
  boxvh: "\u253C",
  boxvl: "\u2524",
  boxvr: "\u251C",
  bprime: "\u2035",
  breve: "\u02D8",
  brvbar: "\xA6",
  bscr: "\u{1D4B7}",
  bsemi: "\u204F",
  bsim: "\u223D",
  bsime: "\u22CD",
  bsol: "\\",
  bsolb: "\u29C5",
  bsolhsub: "\u27C8",
  bull: "\u2022",
  bullet: "\u2022",
  bump: "\u224E",
  bumpE: "\u2AAE",
  bumpe: "\u224F",
  bumpeq: "\u224F",
  cacute: "\u0107",
  cap: "\u2229",
  capand: "\u2A44",
  capbrcup: "\u2A49",
  capcap: "\u2A4B",
  capcup: "\u2A47",
  capdot: "\u2A40",
  caps: "\u2229\uFE00",
  caret: "\u2041",
  caron: "\u02C7",
  ccaps: "\u2A4D",
  ccaron: "\u010D",
  ccedil: "\xE7",
  ccirc: "\u0109",
  ccups: "\u2A4C",
  ccupssm: "\u2A50",
  cdot: "\u010B",
  cedil: "\xB8",
  cemptyv: "\u29B2",
  cent: "\xA2",
  centerdot: "\xB7",
  cfr: "\u{1D520}",
  chcy: "\u0447",
  check: "\u2713",
  checkmark: "\u2713",
  chi: "\u03C7",
  cir: "\u25CB",
  cirE: "\u29C3",
  circ: "\u02C6",
  circeq: "\u2257",
  circlearrowleft: "\u21BA",
  circlearrowright: "\u21BB",
  circledR: "\xAE",
  circledS: "\u24C8",
  circledast: "\u229B",
  circledcirc: "\u229A",
  circleddash: "\u229D",
  cire: "\u2257",
  cirfnint: "\u2A10",
  cirmid: "\u2AEF",
  cirscir: "\u29C2",
  clubs: "\u2663",
  clubsuit: "\u2663",
  colon: ":",
  colone: "\u2254",
  coloneq: "\u2254",
  comma: ",",
  commat: "@",
  comp: "\u2201",
  compfn: "\u2218",
  complement: "\u2201",
  complexes: "\u2102",
  cong: "\u2245",
  congdot: "\u2A6D",
  conint: "\u222E",
  copf: "\u{1D554}",
  coprod: "\u2210",
  copy: "\xA9",
  copysr: "\u2117",
  crarr: "\u21B5",
  cross: "\u2717",
  cscr: "\u{1D4B8}",
  csub: "\u2ACF",
  csube: "\u2AD1",
  csup: "\u2AD0",
  csupe: "\u2AD2",
  ctdot: "\u22EF",
  cudarrl: "\u2938",
  cudarrr: "\u2935",
  cuepr: "\u22DE",
  cuesc: "\u22DF",
  cularr: "\u21B6",
  cularrp: "\u293D",
  cup: "\u222A",
  cupbrcap: "\u2A48",
  cupcap: "\u2A46",
  cupcup: "\u2A4A",
  cupdot: "\u228D",
  cupor: "\u2A45",
  cups: "\u222A\uFE00",
  curarr: "\u21B7",
  curarrm: "\u293C",
  curlyeqprec: "\u22DE",
  curlyeqsucc: "\u22DF",
  curlyvee: "\u22CE",
  curlywedge: "\u22CF",
  curren: "\xA4",
  curvearrowleft: "\u21B6",
  curvearrowright: "\u21B7",
  cuvee: "\u22CE",
  cuwed: "\u22CF",
  cwconint: "\u2232",
  cwint: "\u2231",
  cylcty: "\u232D",
  dArr: "\u21D3",
  dHar: "\u2965",
  dagger: "\u2020",
  daleth: "\u2138",
  darr: "\u2193",
  dash: "\u2010",
  dashv: "\u22A3",
  dbkarow: "\u290F",
  dblac: "\u02DD",
  dcaron: "\u010F",
  dcy: "\u0434",
  dd: "\u2146",
  ddagger: "\u2021",
  ddarr: "\u21CA",
  ddotseq: "\u2A77",
  deg: "\xB0",
  delta: "\u03B4",
  demptyv: "\u29B1",
  dfisht: "\u297F",
  dfr: "\u{1D521}",
  dharl: "\u21C3",
  dharr: "\u21C2",
  diam: "\u22C4",
  diamond: "\u22C4",
  diamondsuit: "\u2666",
  diams: "\u2666",
  die: "\xA8",
  digamma: "\u03DD",
  disin: "\u22F2",
  div: "\xF7",
  divide: "\xF7",
  divideontimes: "\u22C7",
  divonx: "\u22C7",
  djcy: "\u0452",
  dlcorn: "\u231E",
  dlcrop: "\u230D",
  dollar: "$",
  dopf: "\u{1D555}",
  dot: "\u02D9",
  doteq: "\u2250",
  doteqdot: "\u2251",
  dotminus: "\u2238",
  dotplus: "\u2214",
  dotsquare: "\u22A1",
  doublebarwedge: "\u2306",
  downarrow: "\u2193",
  downdownarrows: "\u21CA",
  downharpoonleft: "\u21C3",
  downharpoonright: "\u21C2",
  drbkarow: "\u2910",
  drcorn: "\u231F",
  drcrop: "\u230C",
  dscr: "\u{1D4B9}",
  dscy: "\u0455",
  dsol: "\u29F6",
  dstrok: "\u0111",
  dtdot: "\u22F1",
  dtri: "\u25BF",
  dtrif: "\u25BE",
  duarr: "\u21F5",
  duhar: "\u296F",
  dwangle: "\u29A6",
  dzcy: "\u045F",
  dzigrarr: "\u27FF",
  eDDot: "\u2A77",
  eDot: "\u2251",
  eacute: "\xE9",
  easter: "\u2A6E",
  ecaron: "\u011B",
  ecir: "\u2256",
  ecirc: "\xEA",
  ecolon: "\u2255",
  ecy: "\u044D",
  edot: "\u0117",
  ee: "\u2147",
  efDot: "\u2252",
  efr: "\u{1D522}",
  eg: "\u2A9A",
  egrave: "\xE8",
  egs: "\u2A96",
  egsdot: "\u2A98",
  el: "\u2A99",
  elinters: "\u23E7",
  ell: "\u2113",
  els: "\u2A95",
  elsdot: "\u2A97",
  emacr: "\u0113",
  empty: "\u2205",
  emptyset: "\u2205",
  emptyv: "\u2205",
  emsp13: "\u2004",
  emsp14: "\u2005",
  emsp: "\u2003",
  eng: "\u014B",
  ensp: "\u2002",
  eogon: "\u0119",
  eopf: "\u{1D556}",
  epar: "\u22D5",
  eparsl: "\u29E3",
  eplus: "\u2A71",
  epsi: "\u03B5",
  epsilon: "\u03B5",
  epsiv: "\u03F5",
  eqcirc: "\u2256",
  eqcolon: "\u2255",
  eqsim: "\u2242",
  eqslantgtr: "\u2A96",
  eqslantless: "\u2A95",
  equals: "=",
  equest: "\u225F",
  equiv: "\u2261",
  equivDD: "\u2A78",
  eqvparsl: "\u29E5",
  erDot: "\u2253",
  erarr: "\u2971",
  escr: "\u212F",
  esdot: "\u2250",
  esim: "\u2242",
  eta: "\u03B7",
  eth: "\xF0",
  euml: "\xEB",
  euro: "\u20AC",
  excl: "!",
  exist: "\u2203",
  expectation: "\u2130",
  exponentiale: "\u2147",
  fallingdotseq: "\u2252",
  fcy: "\u0444",
  female: "\u2640",
  ffilig: "\uFB03",
  fflig: "\uFB00",
  ffllig: "\uFB04",
  ffr: "\u{1D523}",
  filig: "\uFB01",
  fjlig: "fj",
  flat: "\u266D",
  fllig: "\uFB02",
  fltns: "\u25B1",
  fnof: "\u0192",
  fopf: "\u{1D557}",
  forall: "\u2200",
  fork: "\u22D4",
  forkv: "\u2AD9",
  fpartint: "\u2A0D",
  frac12: "\xBD",
  frac13: "\u2153",
  frac14: "\xBC",
  frac15: "\u2155",
  frac16: "\u2159",
  frac18: "\u215B",
  frac23: "\u2154",
  frac25: "\u2156",
  frac34: "\xBE",
  frac35: "\u2157",
  frac38: "\u215C",
  frac45: "\u2158",
  frac56: "\u215A",
  frac58: "\u215D",
  frac78: "\u215E",
  frasl: "\u2044",
  frown: "\u2322",
  fscr: "\u{1D4BB}",
  gE: "\u2267",
  gEl: "\u2A8C",
  gacute: "\u01F5",
  gamma: "\u03B3",
  gammad: "\u03DD",
  gap: "\u2A86",
  gbreve: "\u011F",
  gcirc: "\u011D",
  gcy: "\u0433",
  gdot: "\u0121",
  ge: "\u2265",
  gel: "\u22DB",
  geq: "\u2265",
  geqq: "\u2267",
  geqslant: "\u2A7E",
  ges: "\u2A7E",
  gescc: "\u2AA9",
  gesdot: "\u2A80",
  gesdoto: "\u2A82",
  gesdotol: "\u2A84",
  gesl: "\u22DB\uFE00",
  gesles: "\u2A94",
  gfr: "\u{1D524}",
  gg: "\u226B",
  ggg: "\u22D9",
  gimel: "\u2137",
  gjcy: "\u0453",
  gl: "\u2277",
  glE: "\u2A92",
  gla: "\u2AA5",
  glj: "\u2AA4",
  gnE: "\u2269",
  gnap: "\u2A8A",
  gnapprox: "\u2A8A",
  gne: "\u2A88",
  gneq: "\u2A88",
  gneqq: "\u2269",
  gnsim: "\u22E7",
  gopf: "\u{1D558}",
  grave: "`",
  gscr: "\u210A",
  gsim: "\u2273",
  gsime: "\u2A8E",
  gsiml: "\u2A90",
  gt: ">",
  gtcc: "\u2AA7",
  gtcir: "\u2A7A",
  gtdot: "\u22D7",
  gtlPar: "\u2995",
  gtquest: "\u2A7C",
  gtrapprox: "\u2A86",
  gtrarr: "\u2978",
  gtrdot: "\u22D7",
  gtreqless: "\u22DB",
  gtreqqless: "\u2A8C",
  gtrless: "\u2277",
  gtrsim: "\u2273",
  gvertneqq: "\u2269\uFE00",
  gvnE: "\u2269\uFE00",
  hArr: "\u21D4",
  hairsp: "\u200A",
  half: "\xBD",
  hamilt: "\u210B",
  hardcy: "\u044A",
  harr: "\u2194",
  harrcir: "\u2948",
  harrw: "\u21AD",
  hbar: "\u210F",
  hcirc: "\u0125",
  hearts: "\u2665",
  heartsuit: "\u2665",
  hellip: "\u2026",
  hercon: "\u22B9",
  hfr: "\u{1D525}",
  hksearow: "\u2925",
  hkswarow: "\u2926",
  hoarr: "\u21FF",
  homtht: "\u223B",
  hookleftarrow: "\u21A9",
  hookrightarrow: "\u21AA",
  hopf: "\u{1D559}",
  horbar: "\u2015",
  hscr: "\u{1D4BD}",
  hslash: "\u210F",
  hstrok: "\u0127",
  hybull: "\u2043",
  hyphen: "\u2010",
  iacute: "\xED",
  ic: "\u2063",
  icirc: "\xEE",
  icy: "\u0438",
  iecy: "\u0435",
  iexcl: "\xA1",
  iff: "\u21D4",
  ifr: "\u{1D526}",
  igrave: "\xEC",
  ii: "\u2148",
  iiiint: "\u2A0C",
  iiint: "\u222D",
  iinfin: "\u29DC",
  iiota: "\u2129",
  ijlig: "\u0133",
  imacr: "\u012B",
  image: "\u2111",
  imagline: "\u2110",
  imagpart: "\u2111",
  imath: "\u0131",
  imof: "\u22B7",
  imped: "\u01B5",
  in: "\u2208",
  incare: "\u2105",
  infin: "\u221E",
  infintie: "\u29DD",
  inodot: "\u0131",
  int: "\u222B",
  intcal: "\u22BA",
  integers: "\u2124",
  intercal: "\u22BA",
  intlarhk: "\u2A17",
  intprod: "\u2A3C",
  iocy: "\u0451",
  iogon: "\u012F",
  iopf: "\u{1D55A}",
  iota: "\u03B9",
  iprod: "\u2A3C",
  iquest: "\xBF",
  iscr: "\u{1D4BE}",
  isin: "\u2208",
  isinE: "\u22F9",
  isindot: "\u22F5",
  isins: "\u22F4",
  isinsv: "\u22F3",
  isinv: "\u2208",
  it: "\u2062",
  itilde: "\u0129",
  iukcy: "\u0456",
  iuml: "\xEF",
  jcirc: "\u0135",
  jcy: "\u0439",
  jfr: "\u{1D527}",
  jmath: "\u0237",
  jopf: "\u{1D55B}",
  jscr: "\u{1D4BF}",
  jsercy: "\u0458",
  jukcy: "\u0454",
  kappa: "\u03BA",
  kappav: "\u03F0",
  kcedil: "\u0137",
  kcy: "\u043A",
  kfr: "\u{1D528}",
  kgreen: "\u0138",
  khcy: "\u0445",
  kjcy: "\u045C",
  kopf: "\u{1D55C}",
  kscr: "\u{1D4C0}",
  lAarr: "\u21DA",
  lArr: "\u21D0",
  lAtail: "\u291B",
  lBarr: "\u290E",
  lE: "\u2266",
  lEg: "\u2A8B",
  lHar: "\u2962",
  lacute: "\u013A",
  laemptyv: "\u29B4",
  lagran: "\u2112",
  lambda: "\u03BB",
  lang: "\u27E8",
  langd: "\u2991",
  langle: "\u27E8",
  lap: "\u2A85",
  laquo: "\xAB",
  larr: "\u2190",
  larrb: "\u21E4",
  larrbfs: "\u291F",
  larrfs: "\u291D",
  larrhk: "\u21A9",
  larrlp: "\u21AB",
  larrpl: "\u2939",
  larrsim: "\u2973",
  larrtl: "\u21A2",
  lat: "\u2AAB",
  latail: "\u2919",
  late: "\u2AAD",
  lates: "\u2AAD\uFE00",
  lbarr: "\u290C",
  lbbrk: "\u2772",
  lbrace: "{",
  lbrack: "[",
  lbrke: "\u298B",
  lbrksld: "\u298F",
  lbrkslu: "\u298D",
  lcaron: "\u013E",
  lcedil: "\u013C",
  lceil: "\u2308",
  lcub: "{",
  lcy: "\u043B",
  ldca: "\u2936",
  ldquo: "\u201C",
  ldquor: "\u201E",
  ldrdhar: "\u2967",
  ldrushar: "\u294B",
  ldsh: "\u21B2",
  le: "\u2264",
  leftarrow: "\u2190",
  leftarrowtail: "\u21A2",
  leftharpoondown: "\u21BD",
  leftharpoonup: "\u21BC",
  leftleftarrows: "\u21C7",
  leftrightarrow: "\u2194",
  leftrightarrows: "\u21C6",
  leftrightharpoons: "\u21CB",
  leftrightsquigarrow: "\u21AD",
  leftthreetimes: "\u22CB",
  leg: "\u22DA",
  leq: "\u2264",
  leqq: "\u2266",
  leqslant: "\u2A7D",
  les: "\u2A7D",
  lescc: "\u2AA8",
  lesdot: "\u2A7F",
  lesdoto: "\u2A81",
  lesdotor: "\u2A83",
  lesg: "\u22DA\uFE00",
  lesges: "\u2A93",
  lessapprox: "\u2A85",
  lessdot: "\u22D6",
  lesseqgtr: "\u22DA",
  lesseqqgtr: "\u2A8B",
  lessgtr: "\u2276",
  lesssim: "\u2272",
  lfisht: "\u297C",
  lfloor: "\u230A",
  lfr: "\u{1D529}",
  lg: "\u2276",
  lgE: "\u2A91",
  lhard: "\u21BD",
  lharu: "\u21BC",
  lharul: "\u296A",
  lhblk: "\u2584",
  ljcy: "\u0459",
  ll: "\u226A",
  llarr: "\u21C7",
  llcorner: "\u231E",
  llhard: "\u296B",
  lltri: "\u25FA",
  lmidot: "\u0140",
  lmoust: "\u23B0",
  lmoustache: "\u23B0",
  lnE: "\u2268",
  lnap: "\u2A89",
  lnapprox: "\u2A89",
  lne: "\u2A87",
  lneq: "\u2A87",
  lneqq: "\u2268",
  lnsim: "\u22E6",
  loang: "\u27EC",
  loarr: "\u21FD",
  lobrk: "\u27E6",
  longleftarrow: "\u27F5",
  longleftrightarrow: "\u27F7",
  longmapsto: "\u27FC",
  longrightarrow: "\u27F6",
  looparrowleft: "\u21AB",
  looparrowright: "\u21AC",
  lopar: "\u2985",
  lopf: "\u{1D55D}",
  loplus: "\u2A2D",
  lotimes: "\u2A34",
  lowast: "\u2217",
  lowbar: "_",
  loz: "\u25CA",
  lozenge: "\u25CA",
  lozf: "\u29EB",
  lpar: "(",
  lparlt: "\u2993",
  lrarr: "\u21C6",
  lrcorner: "\u231F",
  lrhar: "\u21CB",
  lrhard: "\u296D",
  lrm: "\u200E",
  lrtri: "\u22BF",
  lsaquo: "\u2039",
  lscr: "\u{1D4C1}",
  lsh: "\u21B0",
  lsim: "\u2272",
  lsime: "\u2A8D",
  lsimg: "\u2A8F",
  lsqb: "[",
  lsquo: "\u2018",
  lsquor: "\u201A",
  lstrok: "\u0142",
  lt: "<",
  ltcc: "\u2AA6",
  ltcir: "\u2A79",
  ltdot: "\u22D6",
  lthree: "\u22CB",
  ltimes: "\u22C9",
  ltlarr: "\u2976",
  ltquest: "\u2A7B",
  ltrPar: "\u2996",
  ltri: "\u25C3",
  ltrie: "\u22B4",
  ltrif: "\u25C2",
  lurdshar: "\u294A",
  luruhar: "\u2966",
  lvertneqq: "\u2268\uFE00",
  lvnE: "\u2268\uFE00",
  mDDot: "\u223A",
  macr: "\xAF",
  male: "\u2642",
  malt: "\u2720",
  maltese: "\u2720",
  map: "\u21A6",
  mapsto: "\u21A6",
  mapstodown: "\u21A7",
  mapstoleft: "\u21A4",
  mapstoup: "\u21A5",
  marker: "\u25AE",
  mcomma: "\u2A29",
  mcy: "\u043C",
  mdash: "\u2014",
  measuredangle: "\u2221",
  mfr: "\u{1D52A}",
  mho: "\u2127",
  micro: "\xB5",
  mid: "\u2223",
  midast: "*",
  midcir: "\u2AF0",
  middot: "\xB7",
  minus: "\u2212",
  minusb: "\u229F",
  minusd: "\u2238",
  minusdu: "\u2A2A",
  mlcp: "\u2ADB",
  mldr: "\u2026",
  mnplus: "\u2213",
  models: "\u22A7",
  mopf: "\u{1D55E}",
  mp: "\u2213",
  mscr: "\u{1D4C2}",
  mstpos: "\u223E",
  mu: "\u03BC",
  multimap: "\u22B8",
  mumap: "\u22B8",
  nGg: "\u22D9\u0338",
  nGt: "\u226B\u20D2",
  nGtv: "\u226B\u0338",
  nLeftarrow: "\u21CD",
  nLeftrightarrow: "\u21CE",
  nLl: "\u22D8\u0338",
  nLt: "\u226A\u20D2",
  nLtv: "\u226A\u0338",
  nRightarrow: "\u21CF",
  nVDash: "\u22AF",
  nVdash: "\u22AE",
  nabla: "\u2207",
  nacute: "\u0144",
  nang: "\u2220\u20D2",
  nap: "\u2249",
  napE: "\u2A70\u0338",
  napid: "\u224B\u0338",
  napos: "\u0149",
  napprox: "\u2249",
  natur: "\u266E",
  natural: "\u266E",
  naturals: "\u2115",
  nbsp: "\xA0",
  nbump: "\u224E\u0338",
  nbumpe: "\u224F\u0338",
  ncap: "\u2A43",
  ncaron: "\u0148",
  ncedil: "\u0146",
  ncong: "\u2247",
  ncongdot: "\u2A6D\u0338",
  ncup: "\u2A42",
  ncy: "\u043D",
  ndash: "\u2013",
  ne: "\u2260",
  neArr: "\u21D7",
  nearhk: "\u2924",
  nearr: "\u2197",
  nearrow: "\u2197",
  nedot: "\u2250\u0338",
  nequiv: "\u2262",
  nesear: "\u2928",
  nesim: "\u2242\u0338",
  nexist: "\u2204",
  nexists: "\u2204",
  nfr: "\u{1D52B}",
  ngE: "\u2267\u0338",
  nge: "\u2271",
  ngeq: "\u2271",
  ngeqq: "\u2267\u0338",
  ngeqslant: "\u2A7E\u0338",
  nges: "\u2A7E\u0338",
  ngsim: "\u2275",
  ngt: "\u226F",
  ngtr: "\u226F",
  nhArr: "\u21CE",
  nharr: "\u21AE",
  nhpar: "\u2AF2",
  ni: "\u220B",
  nis: "\u22FC",
  nisd: "\u22FA",
  niv: "\u220B",
  njcy: "\u045A",
  nlArr: "\u21CD",
  nlE: "\u2266\u0338",
  nlarr: "\u219A",
  nldr: "\u2025",
  nle: "\u2270",
  nleftarrow: "\u219A",
  nleftrightarrow: "\u21AE",
  nleq: "\u2270",
  nleqq: "\u2266\u0338",
  nleqslant: "\u2A7D\u0338",
  nles: "\u2A7D\u0338",
  nless: "\u226E",
  nlsim: "\u2274",
  nlt: "\u226E",
  nltri: "\u22EA",
  nltrie: "\u22EC",
  nmid: "\u2224",
  nopf: "\u{1D55F}",
  not: "\xAC",
  notin: "\u2209",
  notinE: "\u22F9\u0338",
  notindot: "\u22F5\u0338",
  notinva: "\u2209",
  notinvb: "\u22F7",
  notinvc: "\u22F6",
  notni: "\u220C",
  notniva: "\u220C",
  notnivb: "\u22FE",
  notnivc: "\u22FD",
  npar: "\u2226",
  nparallel: "\u2226",
  nparsl: "\u2AFD\u20E5",
  npart: "\u2202\u0338",
  npolint: "\u2A14",
  npr: "\u2280",
  nprcue: "\u22E0",
  npre: "\u2AAF\u0338",
  nprec: "\u2280",
  npreceq: "\u2AAF\u0338",
  nrArr: "\u21CF",
  nrarr: "\u219B",
  nrarrc: "\u2933\u0338",
  nrarrw: "\u219D\u0338",
  nrightarrow: "\u219B",
  nrtri: "\u22EB",
  nrtrie: "\u22ED",
  nsc: "\u2281",
  nsccue: "\u22E1",
  nsce: "\u2AB0\u0338",
  nscr: "\u{1D4C3}",
  nshortmid: "\u2224",
  nshortparallel: "\u2226",
  nsim: "\u2241",
  nsime: "\u2244",
  nsimeq: "\u2244",
  nsmid: "\u2224",
  nspar: "\u2226",
  nsqsube: "\u22E2",
  nsqsupe: "\u22E3",
  nsub: "\u2284",
  nsubE: "\u2AC5\u0338",
  nsube: "\u2288",
  nsubset: "\u2282\u20D2",
  nsubseteq: "\u2288",
  nsubseteqq: "\u2AC5\u0338",
  nsucc: "\u2281",
  nsucceq: "\u2AB0\u0338",
  nsup: "\u2285",
  nsupE: "\u2AC6\u0338",
  nsupe: "\u2289",
  nsupset: "\u2283\u20D2",
  nsupseteq: "\u2289",
  nsupseteqq: "\u2AC6\u0338",
  ntgl: "\u2279",
  ntilde: "\xF1",
  ntlg: "\u2278",
  ntriangleleft: "\u22EA",
  ntrianglelefteq: "\u22EC",
  ntriangleright: "\u22EB",
  ntrianglerighteq: "\u22ED",
  nu: "\u03BD",
  num: "#",
  numero: "\u2116",
  numsp: "\u2007",
  nvDash: "\u22AD",
  nvHarr: "\u2904",
  nvap: "\u224D\u20D2",
  nvdash: "\u22AC",
  nvge: "\u2265\u20D2",
  nvgt: ">\u20D2",
  nvinfin: "\u29DE",
  nvlArr: "\u2902",
  nvle: "\u2264\u20D2",
  nvlt: "<\u20D2",
  nvltrie: "\u22B4\u20D2",
  nvrArr: "\u2903",
  nvrtrie: "\u22B5\u20D2",
  nvsim: "\u223C\u20D2",
  nwArr: "\u21D6",
  nwarhk: "\u2923",
  nwarr: "\u2196",
  nwarrow: "\u2196",
  nwnear: "\u2927",
  oS: "\u24C8",
  oacute: "\xF3",
  oast: "\u229B",
  ocir: "\u229A",
  ocirc: "\xF4",
  ocy: "\u043E",
  odash: "\u229D",
  odblac: "\u0151",
  odiv: "\u2A38",
  odot: "\u2299",
  odsold: "\u29BC",
  oelig: "\u0153",
  ofcir: "\u29BF",
  ofr: "\u{1D52C}",
  ogon: "\u02DB",
  ograve: "\xF2",
  ogt: "\u29C1",
  ohbar: "\u29B5",
  ohm: "\u03A9",
  oint: "\u222E",
  olarr: "\u21BA",
  olcir: "\u29BE",
  olcross: "\u29BB",
  oline: "\u203E",
  olt: "\u29C0",
  omacr: "\u014D",
  omega: "\u03C9",
  omicron: "\u03BF",
  omid: "\u29B6",
  ominus: "\u2296",
  oopf: "\u{1D560}",
  opar: "\u29B7",
  operp: "\u29B9",
  oplus: "\u2295",
  or: "\u2228",
  orarr: "\u21BB",
  ord: "\u2A5D",
  order: "\u2134",
  orderof: "\u2134",
  ordf: "\xAA",
  ordm: "\xBA",
  origof: "\u22B6",
  oror: "\u2A56",
  orslope: "\u2A57",
  orv: "\u2A5B",
  oscr: "\u2134",
  oslash: "\xF8",
  osol: "\u2298",
  otilde: "\xF5",
  otimes: "\u2297",
  otimesas: "\u2A36",
  ouml: "\xF6",
  ovbar: "\u233D",
  par: "\u2225",
  para: "\xB6",
  parallel: "\u2225",
  parsim: "\u2AF3",
  parsl: "\u2AFD",
  part: "\u2202",
  pcy: "\u043F",
  percnt: "%",
  period: ".",
  permil: "\u2030",
  perp: "\u22A5",
  pertenk: "\u2031",
  pfr: "\u{1D52D}",
  phi: "\u03C6",
  phiv: "\u03D5",
  phmmat: "\u2133",
  phone: "\u260E",
  pi: "\u03C0",
  pitchfork: "\u22D4",
  piv: "\u03D6",
  planck: "\u210F",
  planckh: "\u210E",
  plankv: "\u210F",
  plus: "+",
  plusacir: "\u2A23",
  plusb: "\u229E",
  pluscir: "\u2A22",
  plusdo: "\u2214",
  plusdu: "\u2A25",
  pluse: "\u2A72",
  plusmn: "\xB1",
  plussim: "\u2A26",
  plustwo: "\u2A27",
  pm: "\xB1",
  pointint: "\u2A15",
  popf: "\u{1D561}",
  pound: "\xA3",
  pr: "\u227A",
  prE: "\u2AB3",
  prap: "\u2AB7",
  prcue: "\u227C",
  pre: "\u2AAF",
  prec: "\u227A",
  precapprox: "\u2AB7",
  preccurlyeq: "\u227C",
  preceq: "\u2AAF",
  precnapprox: "\u2AB9",
  precneqq: "\u2AB5",
  precnsim: "\u22E8",
  precsim: "\u227E",
  prime: "\u2032",
  primes: "\u2119",
  prnE: "\u2AB5",
  prnap: "\u2AB9",
  prnsim: "\u22E8",
  prod: "\u220F",
  profalar: "\u232E",
  profline: "\u2312",
  profsurf: "\u2313",
  prop: "\u221D",
  propto: "\u221D",
  prsim: "\u227E",
  prurel: "\u22B0",
  pscr: "\u{1D4C5}",
  psi: "\u03C8",
  puncsp: "\u2008",
  qfr: "\u{1D52E}",
  qint: "\u2A0C",
  qopf: "\u{1D562}",
  qprime: "\u2057",
  qscr: "\u{1D4C6}",
  quaternions: "\u210D",
  quatint: "\u2A16",
  quest: "?",
  questeq: "\u225F",
  quot: '"',
  rAarr: "\u21DB",
  rArr: "\u21D2",
  rAtail: "\u291C",
  rBarr: "\u290F",
  rHar: "\u2964",
  race: "\u223D\u0331",
  racute: "\u0155",
  radic: "\u221A",
  raemptyv: "\u29B3",
  rang: "\u27E9",
  rangd: "\u2992",
  range: "\u29A5",
  rangle: "\u27E9",
  raquo: "\xBB",
  rarr: "\u2192",
  rarrap: "\u2975",
  rarrb: "\u21E5",
  rarrbfs: "\u2920",
  rarrc: "\u2933",
  rarrfs: "\u291E",
  rarrhk: "\u21AA",
  rarrlp: "\u21AC",
  rarrpl: "\u2945",
  rarrsim: "\u2974",
  rarrtl: "\u21A3",
  rarrw: "\u219D",
  ratail: "\u291A",
  ratio: "\u2236",
  rationals: "\u211A",
  rbarr: "\u290D",
  rbbrk: "\u2773",
  rbrace: "}",
  rbrack: "]",
  rbrke: "\u298C",
  rbrksld: "\u298E",
  rbrkslu: "\u2990",
  rcaron: "\u0159",
  rcedil: "\u0157",
  rceil: "\u2309",
  rcub: "}",
  rcy: "\u0440",
  rdca: "\u2937",
  rdldhar: "\u2969",
  rdquo: "\u201D",
  rdquor: "\u201D",
  rdsh: "\u21B3",
  real: "\u211C",
  realine: "\u211B",
  realpart: "\u211C",
  reals: "\u211D",
  rect: "\u25AD",
  reg: "\xAE",
  rfisht: "\u297D",
  rfloor: "\u230B",
  rfr: "\u{1D52F}",
  rhard: "\u21C1",
  rharu: "\u21C0",
  rharul: "\u296C",
  rho: "\u03C1",
  rhov: "\u03F1",
  rightarrow: "\u2192",
  rightarrowtail: "\u21A3",
  rightharpoondown: "\u21C1",
  rightharpoonup: "\u21C0",
  rightleftarrows: "\u21C4",
  rightleftharpoons: "\u21CC",
  rightrightarrows: "\u21C9",
  rightsquigarrow: "\u219D",
  rightthreetimes: "\u22CC",
  ring: "\u02DA",
  risingdotseq: "\u2253",
  rlarr: "\u21C4",
  rlhar: "\u21CC",
  rlm: "\u200F",
  rmoust: "\u23B1",
  rmoustache: "\u23B1",
  rnmid: "\u2AEE",
  roang: "\u27ED",
  roarr: "\u21FE",
  robrk: "\u27E7",
  ropar: "\u2986",
  ropf: "\u{1D563}",
  roplus: "\u2A2E",
  rotimes: "\u2A35",
  rpar: ")",
  rpargt: "\u2994",
  rppolint: "\u2A12",
  rrarr: "\u21C9",
  rsaquo: "\u203A",
  rscr: "\u{1D4C7}",
  rsh: "\u21B1",
  rsqb: "]",
  rsquo: "\u2019",
  rsquor: "\u2019",
  rthree: "\u22CC",
  rtimes: "\u22CA",
  rtri: "\u25B9",
  rtrie: "\u22B5",
  rtrif: "\u25B8",
  rtriltri: "\u29CE",
  ruluhar: "\u2968",
  rx: "\u211E",
  sacute: "\u015B",
  sbquo: "\u201A",
  sc: "\u227B",
  scE: "\u2AB4",
  scap: "\u2AB8",
  scaron: "\u0161",
  sccue: "\u227D",
  sce: "\u2AB0",
  scedil: "\u015F",
  scirc: "\u015D",
  scnE: "\u2AB6",
  scnap: "\u2ABA",
  scnsim: "\u22E9",
  scpolint: "\u2A13",
  scsim: "\u227F",
  scy: "\u0441",
  sdot: "\u22C5",
  sdotb: "\u22A1",
  sdote: "\u2A66",
  seArr: "\u21D8",
  searhk: "\u2925",
  searr: "\u2198",
  searrow: "\u2198",
  sect: "\xA7",
  semi: ";",
  seswar: "\u2929",
  setminus: "\u2216",
  setmn: "\u2216",
  sext: "\u2736",
  sfr: "\u{1D530}",
  sfrown: "\u2322",
  sharp: "\u266F",
  shchcy: "\u0449",
  shcy: "\u0448",
  shortmid: "\u2223",
  shortparallel: "\u2225",
  shy: "\xAD",
  sigma: "\u03C3",
  sigmaf: "\u03C2",
  sigmav: "\u03C2",
  sim: "\u223C",
  simdot: "\u2A6A",
  sime: "\u2243",
  simeq: "\u2243",
  simg: "\u2A9E",
  simgE: "\u2AA0",
  siml: "\u2A9D",
  simlE: "\u2A9F",
  simne: "\u2246",
  simplus: "\u2A24",
  simrarr: "\u2972",
  slarr: "\u2190",
  smallsetminus: "\u2216",
  smashp: "\u2A33",
  smeparsl: "\u29E4",
  smid: "\u2223",
  smile: "\u2323",
  smt: "\u2AAA",
  smte: "\u2AAC",
  smtes: "\u2AAC\uFE00",
  softcy: "\u044C",
  sol: "/",
  solb: "\u29C4",
  solbar: "\u233F",
  sopf: "\u{1D564}",
  spades: "\u2660",
  spadesuit: "\u2660",
  spar: "\u2225",
  sqcap: "\u2293",
  sqcaps: "\u2293\uFE00",
  sqcup: "\u2294",
  sqcups: "\u2294\uFE00",
  sqsub: "\u228F",
  sqsube: "\u2291",
  sqsubset: "\u228F",
  sqsubseteq: "\u2291",
  sqsup: "\u2290",
  sqsupe: "\u2292",
  sqsupset: "\u2290",
  sqsupseteq: "\u2292",
  squ: "\u25A1",
  square: "\u25A1",
  squarf: "\u25AA",
  squf: "\u25AA",
  srarr: "\u2192",
  sscr: "\u{1D4C8}",
  ssetmn: "\u2216",
  ssmile: "\u2323",
  sstarf: "\u22C6",
  star: "\u2606",
  starf: "\u2605",
  straightepsilon: "\u03F5",
  straightphi: "\u03D5",
  strns: "\xAF",
  sub: "\u2282",
  subE: "\u2AC5",
  subdot: "\u2ABD",
  sube: "\u2286",
  subedot: "\u2AC3",
  submult: "\u2AC1",
  subnE: "\u2ACB",
  subne: "\u228A",
  subplus: "\u2ABF",
  subrarr: "\u2979",
  subset: "\u2282",
  subseteq: "\u2286",
  subseteqq: "\u2AC5",
  subsetneq: "\u228A",
  subsetneqq: "\u2ACB",
  subsim: "\u2AC7",
  subsub: "\u2AD5",
  subsup: "\u2AD3",
  succ: "\u227B",
  succapprox: "\u2AB8",
  succcurlyeq: "\u227D",
  succeq: "\u2AB0",
  succnapprox: "\u2ABA",
  succneqq: "\u2AB6",
  succnsim: "\u22E9",
  succsim: "\u227F",
  sum: "\u2211",
  sung: "\u266A",
  sup1: "\xB9",
  sup2: "\xB2",
  sup3: "\xB3",
  sup: "\u2283",
  supE: "\u2AC6",
  supdot: "\u2ABE",
  supdsub: "\u2AD8",
  supe: "\u2287",
  supedot: "\u2AC4",
  suphsol: "\u27C9",
  suphsub: "\u2AD7",
  suplarr: "\u297B",
  supmult: "\u2AC2",
  supnE: "\u2ACC",
  supne: "\u228B",
  supplus: "\u2AC0",
  supset: "\u2283",
  supseteq: "\u2287",
  supseteqq: "\u2AC6",
  supsetneq: "\u228B",
  supsetneqq: "\u2ACC",
  supsim: "\u2AC8",
  supsub: "\u2AD4",
  supsup: "\u2AD6",
  swArr: "\u21D9",
  swarhk: "\u2926",
  swarr: "\u2199",
  swarrow: "\u2199",
  swnwar: "\u292A",
  szlig: "\xDF",
  target: "\u2316",
  tau: "\u03C4",
  tbrk: "\u23B4",
  tcaron: "\u0165",
  tcedil: "\u0163",
  tcy: "\u0442",
  tdot: "\u20DB",
  telrec: "\u2315",
  tfr: "\u{1D531}",
  there4: "\u2234",
  therefore: "\u2234",
  theta: "\u03B8",
  thetasym: "\u03D1",
  thetav: "\u03D1",
  thickapprox: "\u2248",
  thicksim: "\u223C",
  thinsp: "\u2009",
  thkap: "\u2248",
  thksim: "\u223C",
  thorn: "\xFE",
  tilde: "\u02DC",
  times: "\xD7",
  timesb: "\u22A0",
  timesbar: "\u2A31",
  timesd: "\u2A30",
  tint: "\u222D",
  toea: "\u2928",
  top: "\u22A4",
  topbot: "\u2336",
  topcir: "\u2AF1",
  topf: "\u{1D565}",
  topfork: "\u2ADA",
  tosa: "\u2929",
  tprime: "\u2034",
  trade: "\u2122",
  triangle: "\u25B5",
  triangledown: "\u25BF",
  triangleleft: "\u25C3",
  trianglelefteq: "\u22B4",
  triangleq: "\u225C",
  triangleright: "\u25B9",
  trianglerighteq: "\u22B5",
  tridot: "\u25EC",
  trie: "\u225C",
  triminus: "\u2A3A",
  triplus: "\u2A39",
  trisb: "\u29CD",
  tritime: "\u2A3B",
  trpezium: "\u23E2",
  tscr: "\u{1D4C9}",
  tscy: "\u0446",
  tshcy: "\u045B",
  tstrok: "\u0167",
  twixt: "\u226C",
  twoheadleftarrow: "\u219E",
  twoheadrightarrow: "\u21A0",
  uArr: "\u21D1",
  uHar: "\u2963",
  uacute: "\xFA",
  uarr: "\u2191",
  ubrcy: "\u045E",
  ubreve: "\u016D",
  ucirc: "\xFB",
  ucy: "\u0443",
  udarr: "\u21C5",
  udblac: "\u0171",
  udhar: "\u296E",
  ufisht: "\u297E",
  ufr: "\u{1D532}",
  ugrave: "\xF9",
  uharl: "\u21BF",
  uharr: "\u21BE",
  uhblk: "\u2580",
  ulcorn: "\u231C",
  ulcorner: "\u231C",
  ulcrop: "\u230F",
  ultri: "\u25F8",
  umacr: "\u016B",
  uml: "\xA8",
  uogon: "\u0173",
  uopf: "\u{1D566}",
  uparrow: "\u2191",
  updownarrow: "\u2195",
  upharpoonleft: "\u21BF",
  upharpoonright: "\u21BE",
  uplus: "\u228E",
  upsi: "\u03C5",
  upsih: "\u03D2",
  upsilon: "\u03C5",
  upuparrows: "\u21C8",
  urcorn: "\u231D",
  urcorner: "\u231D",
  urcrop: "\u230E",
  uring: "\u016F",
  urtri: "\u25F9",
  uscr: "\u{1D4CA}",
  utdot: "\u22F0",
  utilde: "\u0169",
  utri: "\u25B5",
  utrif: "\u25B4",
  uuarr: "\u21C8",
  uuml: "\xFC",
  uwangle: "\u29A7",
  vArr: "\u21D5",
  vBar: "\u2AE8",
  vBarv: "\u2AE9",
  vDash: "\u22A8",
  vangrt: "\u299C",
  varepsilon: "\u03F5",
  varkappa: "\u03F0",
  varnothing: "\u2205",
  varphi: "\u03D5",
  varpi: "\u03D6",
  varpropto: "\u221D",
  varr: "\u2195",
  varrho: "\u03F1",
  varsigma: "\u03C2",
  varsubsetneq: "\u228A\uFE00",
  varsubsetneqq: "\u2ACB\uFE00",
  varsupsetneq: "\u228B\uFE00",
  varsupsetneqq: "\u2ACC\uFE00",
  vartheta: "\u03D1",
  vartriangleleft: "\u22B2",
  vartriangleright: "\u22B3",
  vcy: "\u0432",
  vdash: "\u22A2",
  vee: "\u2228",
  veebar: "\u22BB",
  veeeq: "\u225A",
  vellip: "\u22EE",
  verbar: "|",
  vert: "|",
  vfr: "\u{1D533}",
  vltri: "\u22B2",
  vnsub: "\u2282\u20D2",
  vnsup: "\u2283\u20D2",
  vopf: "\u{1D567}",
  vprop: "\u221D",
  vrtri: "\u22B3",
  vscr: "\u{1D4CB}",
  vsubnE: "\u2ACB\uFE00",
  vsubne: "\u228A\uFE00",
  vsupnE: "\u2ACC\uFE00",
  vsupne: "\u228B\uFE00",
  vzigzag: "\u299A",
  wcirc: "\u0175",
  wedbar: "\u2A5F",
  wedge: "\u2227",
  wedgeq: "\u2259",
  weierp: "\u2118",
  wfr: "\u{1D534}",
  wopf: "\u{1D568}",
  wp: "\u2118",
  wr: "\u2240",
  wreath: "\u2240",
  wscr: "\u{1D4CC}",
  xcap: "\u22C2",
  xcirc: "\u25EF",
  xcup: "\u22C3",
  xdtri: "\u25BD",
  xfr: "\u{1D535}",
  xhArr: "\u27FA",
  xharr: "\u27F7",
  xi: "\u03BE",
  xlArr: "\u27F8",
  xlarr: "\u27F5",
  xmap: "\u27FC",
  xnis: "\u22FB",
  xodot: "\u2A00",
  xopf: "\u{1D569}",
  xoplus: "\u2A01",
  xotime: "\u2A02",
  xrArr: "\u27F9",
  xrarr: "\u27F6",
  xscr: "\u{1D4CD}",
  xsqcup: "\u2A06",
  xuplus: "\u2A04",
  xutri: "\u25B3",
  xvee: "\u22C1",
  xwedge: "\u22C0",
  yacute: "\xFD",
  yacy: "\u044F",
  ycirc: "\u0177",
  ycy: "\u044B",
  yen: "\xA5",
  yfr: "\u{1D536}",
  yicy: "\u0457",
  yopf: "\u{1D56A}",
  yscr: "\u{1D4CE}",
  yucy: "\u044E",
  yuml: "\xFF",
  zacute: "\u017A",
  zcaron: "\u017E",
  zcy: "\u0437",
  zdot: "\u017C",
  zeetrf: "\u2128",
  zeta: "\u03B6",
  zfr: "\u{1D537}",
  zhcy: "\u0436",
  zigrarr: "\u21DD",
  zopf: "\u{1D56B}",
  zscr: "\u{1D4CF}",
  zwj: "\u200D",
  zwnj: "\u200C"
};

// node_modules/decode-named-character-reference/index.js
var own = {}.hasOwnProperty;
function decodeNamedCharacterReference(value) {
  return own.call(characterEntities, value) ? characterEntities[value] : false;
}

// node_modules/gemoji/index.js
var nameToEmoji = {
  100: "\u{1F4AF}",
  1234: "\u{1F522}",
  grinning: "\u{1F600}",
  smiley: "\u{1F603}",
  smile: "\u{1F604}",
  grin: "\u{1F601}",
  laughing: "\u{1F606}",
  satisfied: "\u{1F606}",
  sweat_smile: "\u{1F605}",
  rofl: "\u{1F923}",
  joy: "\u{1F602}",
  slightly_smiling_face: "\u{1F642}",
  upside_down_face: "\u{1F643}",
  melting_face: "\u{1FAE0}",
  wink: "\u{1F609}",
  blush: "\u{1F60A}",
  innocent: "\u{1F607}",
  smiling_face_with_three_hearts: "\u{1F970}",
  heart_eyes: "\u{1F60D}",
  star_struck: "\u{1F929}",
  kissing_heart: "\u{1F618}",
  kissing: "\u{1F617}",
  relaxed: "\u263A\uFE0F",
  kissing_closed_eyes: "\u{1F61A}",
  kissing_smiling_eyes: "\u{1F619}",
  smiling_face_with_tear: "\u{1F972}",
  yum: "\u{1F60B}",
  stuck_out_tongue: "\u{1F61B}",
  stuck_out_tongue_winking_eye: "\u{1F61C}",
  zany_face: "\u{1F92A}",
  stuck_out_tongue_closed_eyes: "\u{1F61D}",
  money_mouth_face: "\u{1F911}",
  hugs: "\u{1F917}",
  hand_over_mouth: "\u{1F92D}",
  face_with_open_eyes_and_hand_over_mouth: "\u{1FAE2}",
  face_with_peeking_eye: "\u{1FAE3}",
  shushing_face: "\u{1F92B}",
  thinking: "\u{1F914}",
  saluting_face: "\u{1FAE1}",
  zipper_mouth_face: "\u{1F910}",
  raised_eyebrow: "\u{1F928}",
  neutral_face: "\u{1F610}",
  expressionless: "\u{1F611}",
  no_mouth: "\u{1F636}",
  dotted_line_face: "\u{1FAE5}",
  face_in_clouds: "\u{1F636}\u200D\u{1F32B}\uFE0F",
  smirk: "\u{1F60F}",
  unamused: "\u{1F612}",
  roll_eyes: "\u{1F644}",
  grimacing: "\u{1F62C}",
  face_exhaling: "\u{1F62E}\u200D\u{1F4A8}",
  lying_face: "\u{1F925}",
  shaking_face: "\u{1FAE8}",
  relieved: "\u{1F60C}",
  pensive: "\u{1F614}",
  sleepy: "\u{1F62A}",
  drooling_face: "\u{1F924}",
  sleeping: "\u{1F634}",
  mask: "\u{1F637}",
  face_with_thermometer: "\u{1F912}",
  face_with_head_bandage: "\u{1F915}",
  nauseated_face: "\u{1F922}",
  vomiting_face: "\u{1F92E}",
  sneezing_face: "\u{1F927}",
  hot_face: "\u{1F975}",
  cold_face: "\u{1F976}",
  woozy_face: "\u{1F974}",
  dizzy_face: "\u{1F635}",
  face_with_spiral_eyes: "\u{1F635}\u200D\u{1F4AB}",
  exploding_head: "\u{1F92F}",
  cowboy_hat_face: "\u{1F920}",
  partying_face: "\u{1F973}",
  disguised_face: "\u{1F978}",
  sunglasses: "\u{1F60E}",
  nerd_face: "\u{1F913}",
  monocle_face: "\u{1F9D0}",
  confused: "\u{1F615}",
  face_with_diagonal_mouth: "\u{1FAE4}",
  worried: "\u{1F61F}",
  slightly_frowning_face: "\u{1F641}",
  frowning_face: "\u2639\uFE0F",
  open_mouth: "\u{1F62E}",
  hushed: "\u{1F62F}",
  astonished: "\u{1F632}",
  flushed: "\u{1F633}",
  pleading_face: "\u{1F97A}",
  face_holding_back_tears: "\u{1F979}",
  frowning: "\u{1F626}",
  anguished: "\u{1F627}",
  fearful: "\u{1F628}",
  cold_sweat: "\u{1F630}",
  disappointed_relieved: "\u{1F625}",
  cry: "\u{1F622}",
  sob: "\u{1F62D}",
  scream: "\u{1F631}",
  confounded: "\u{1F616}",
  persevere: "\u{1F623}",
  disappointed: "\u{1F61E}",
  sweat: "\u{1F613}",
  weary: "\u{1F629}",
  tired_face: "\u{1F62B}",
  yawning_face: "\u{1F971}",
  triumph: "\u{1F624}",
  rage: "\u{1F621}",
  pout: "\u{1F621}",
  angry: "\u{1F620}",
  cursing_face: "\u{1F92C}",
  smiling_imp: "\u{1F608}",
  imp: "\u{1F47F}",
  skull: "\u{1F480}",
  skull_and_crossbones: "\u2620\uFE0F",
  hankey: "\u{1F4A9}",
  poop: "\u{1F4A9}",
  shit: "\u{1F4A9}",
  clown_face: "\u{1F921}",
  japanese_ogre: "\u{1F479}",
  japanese_goblin: "\u{1F47A}",
  ghost: "\u{1F47B}",
  alien: "\u{1F47D}",
  space_invader: "\u{1F47E}",
  robot: "\u{1F916}",
  smiley_cat: "\u{1F63A}",
  smile_cat: "\u{1F638}",
  joy_cat: "\u{1F639}",
  heart_eyes_cat: "\u{1F63B}",
  smirk_cat: "\u{1F63C}",
  kissing_cat: "\u{1F63D}",
  scream_cat: "\u{1F640}",
  crying_cat_face: "\u{1F63F}",
  pouting_cat: "\u{1F63E}",
  see_no_evil: "\u{1F648}",
  hear_no_evil: "\u{1F649}",
  speak_no_evil: "\u{1F64A}",
  love_letter: "\u{1F48C}",
  cupid: "\u{1F498}",
  gift_heart: "\u{1F49D}",
  sparkling_heart: "\u{1F496}",
  heartpulse: "\u{1F497}",
  heartbeat: "\u{1F493}",
  revolving_hearts: "\u{1F49E}",
  two_hearts: "\u{1F495}",
  heart_decoration: "\u{1F49F}",
  heavy_heart_exclamation: "\u2763\uFE0F",
  broken_heart: "\u{1F494}",
  heart_on_fire: "\u2764\uFE0F\u200D\u{1F525}",
  mending_heart: "\u2764\uFE0F\u200D\u{1FA79}",
  heart: "\u2764\uFE0F",
  pink_heart: "\u{1FA77}",
  orange_heart: "\u{1F9E1}",
  yellow_heart: "\u{1F49B}",
  green_heart: "\u{1F49A}",
  blue_heart: "\u{1F499}",
  light_blue_heart: "\u{1FA75}",
  purple_heart: "\u{1F49C}",
  brown_heart: "\u{1F90E}",
  black_heart: "\u{1F5A4}",
  grey_heart: "\u{1FA76}",
  white_heart: "\u{1F90D}",
  kiss: "\u{1F48B}",
  anger: "\u{1F4A2}",
  boom: "\u{1F4A5}",
  collision: "\u{1F4A5}",
  dizzy: "\u{1F4AB}",
  sweat_drops: "\u{1F4A6}",
  dash: "\u{1F4A8}",
  hole: "\u{1F573}\uFE0F",
  speech_balloon: "\u{1F4AC}",
  eye_speech_bubble: "\u{1F441}\uFE0F\u200D\u{1F5E8}\uFE0F",
  left_speech_bubble: "\u{1F5E8}\uFE0F",
  right_anger_bubble: "\u{1F5EF}\uFE0F",
  thought_balloon: "\u{1F4AD}",
  zzz: "\u{1F4A4}",
  wave: "\u{1F44B}",
  raised_back_of_hand: "\u{1F91A}",
  raised_hand_with_fingers_splayed: "\u{1F590}\uFE0F",
  hand: "\u270B",
  raised_hand: "\u270B",
  vulcan_salute: "\u{1F596}",
  rightwards_hand: "\u{1FAF1}",
  leftwards_hand: "\u{1FAF2}",
  palm_down_hand: "\u{1FAF3}",
  palm_up_hand: "\u{1FAF4}",
  leftwards_pushing_hand: "\u{1FAF7}",
  rightwards_pushing_hand: "\u{1FAF8}",
  ok_hand: "\u{1F44C}",
  pinched_fingers: "\u{1F90C}",
  pinching_hand: "\u{1F90F}",
  v: "\u270C\uFE0F",
  crossed_fingers: "\u{1F91E}",
  hand_with_index_finger_and_thumb_crossed: "\u{1FAF0}",
  love_you_gesture: "\u{1F91F}",
  metal: "\u{1F918}",
  call_me_hand: "\u{1F919}",
  point_left: "\u{1F448}",
  point_right: "\u{1F449}",
  point_up_2: "\u{1F446}",
  middle_finger: "\u{1F595}",
  fu: "\u{1F595}",
  point_down: "\u{1F447}",
  point_up: "\u261D\uFE0F",
  index_pointing_at_the_viewer: "\u{1FAF5}",
  "+1": "\u{1F44D}",
  thumbsup: "\u{1F44D}",
  "-1": "\u{1F44E}",
  thumbsdown: "\u{1F44E}",
  fist_raised: "\u270A",
  fist: "\u270A",
  fist_oncoming: "\u{1F44A}",
  facepunch: "\u{1F44A}",
  punch: "\u{1F44A}",
  fist_left: "\u{1F91B}",
  fist_right: "\u{1F91C}",
  clap: "\u{1F44F}",
  raised_hands: "\u{1F64C}",
  heart_hands: "\u{1FAF6}",
  open_hands: "\u{1F450}",
  palms_up_together: "\u{1F932}",
  handshake: "\u{1F91D}",
  pray: "\u{1F64F}",
  writing_hand: "\u270D\uFE0F",
  nail_care: "\u{1F485}",
  selfie: "\u{1F933}",
  muscle: "\u{1F4AA}",
  mechanical_arm: "\u{1F9BE}",
  mechanical_leg: "\u{1F9BF}",
  leg: "\u{1F9B5}",
  foot: "\u{1F9B6}",
  ear: "\u{1F442}",
  ear_with_hearing_aid: "\u{1F9BB}",
  nose: "\u{1F443}",
  brain: "\u{1F9E0}",
  anatomical_heart: "\u{1FAC0}",
  lungs: "\u{1FAC1}",
  tooth: "\u{1F9B7}",
  bone: "\u{1F9B4}",
  eyes: "\u{1F440}",
  eye: "\u{1F441}\uFE0F",
  tongue: "\u{1F445}",
  lips: "\u{1F444}",
  biting_lip: "\u{1FAE6}",
  baby: "\u{1F476}",
  child: "\u{1F9D2}",
  boy: "\u{1F466}",
  girl: "\u{1F467}",
  adult: "\u{1F9D1}",
  blond_haired_person: "\u{1F471}",
  man: "\u{1F468}",
  bearded_person: "\u{1F9D4}",
  man_beard: "\u{1F9D4}\u200D\u2642\uFE0F",
  woman_beard: "\u{1F9D4}\u200D\u2640\uFE0F",
  red_haired_man: "\u{1F468}\u200D\u{1F9B0}",
  curly_haired_man: "\u{1F468}\u200D\u{1F9B1}",
  white_haired_man: "\u{1F468}\u200D\u{1F9B3}",
  bald_man: "\u{1F468}\u200D\u{1F9B2}",
  woman: "\u{1F469}",
  red_haired_woman: "\u{1F469}\u200D\u{1F9B0}",
  person_red_hair: "\u{1F9D1}\u200D\u{1F9B0}",
  curly_haired_woman: "\u{1F469}\u200D\u{1F9B1}",
  person_curly_hair: "\u{1F9D1}\u200D\u{1F9B1}",
  white_haired_woman: "\u{1F469}\u200D\u{1F9B3}",
  person_white_hair: "\u{1F9D1}\u200D\u{1F9B3}",
  bald_woman: "\u{1F469}\u200D\u{1F9B2}",
  person_bald: "\u{1F9D1}\u200D\u{1F9B2}",
  blond_haired_woman: "\u{1F471}\u200D\u2640\uFE0F",
  blonde_woman: "\u{1F471}\u200D\u2640\uFE0F",
  blond_haired_man: "\u{1F471}\u200D\u2642\uFE0F",
  older_adult: "\u{1F9D3}",
  older_man: "\u{1F474}",
  older_woman: "\u{1F475}",
  frowning_person: "\u{1F64D}",
  frowning_man: "\u{1F64D}\u200D\u2642\uFE0F",
  frowning_woman: "\u{1F64D}\u200D\u2640\uFE0F",
  pouting_face: "\u{1F64E}",
  pouting_man: "\u{1F64E}\u200D\u2642\uFE0F",
  pouting_woman: "\u{1F64E}\u200D\u2640\uFE0F",
  no_good: "\u{1F645}",
  no_good_man: "\u{1F645}\u200D\u2642\uFE0F",
  ng_man: "\u{1F645}\u200D\u2642\uFE0F",
  no_good_woman: "\u{1F645}\u200D\u2640\uFE0F",
  ng_woman: "\u{1F645}\u200D\u2640\uFE0F",
  ok_person: "\u{1F646}",
  ok_man: "\u{1F646}\u200D\u2642\uFE0F",
  ok_woman: "\u{1F646}\u200D\u2640\uFE0F",
  tipping_hand_person: "\u{1F481}",
  information_desk_person: "\u{1F481}",
  tipping_hand_man: "\u{1F481}\u200D\u2642\uFE0F",
  sassy_man: "\u{1F481}\u200D\u2642\uFE0F",
  tipping_hand_woman: "\u{1F481}\u200D\u2640\uFE0F",
  sassy_woman: "\u{1F481}\u200D\u2640\uFE0F",
  raising_hand: "\u{1F64B}",
  raising_hand_man: "\u{1F64B}\u200D\u2642\uFE0F",
  raising_hand_woman: "\u{1F64B}\u200D\u2640\uFE0F",
  deaf_person: "\u{1F9CF}",
  deaf_man: "\u{1F9CF}\u200D\u2642\uFE0F",
  deaf_woman: "\u{1F9CF}\u200D\u2640\uFE0F",
  bow: "\u{1F647}",
  bowing_man: "\u{1F647}\u200D\u2642\uFE0F",
  bowing_woman: "\u{1F647}\u200D\u2640\uFE0F",
  facepalm: "\u{1F926}",
  man_facepalming: "\u{1F926}\u200D\u2642\uFE0F",
  woman_facepalming: "\u{1F926}\u200D\u2640\uFE0F",
  shrug: "\u{1F937}",
  man_shrugging: "\u{1F937}\u200D\u2642\uFE0F",
  woman_shrugging: "\u{1F937}\u200D\u2640\uFE0F",
  health_worker: "\u{1F9D1}\u200D\u2695\uFE0F",
  man_health_worker: "\u{1F468}\u200D\u2695\uFE0F",
  woman_health_worker: "\u{1F469}\u200D\u2695\uFE0F",
  student: "\u{1F9D1}\u200D\u{1F393}",
  man_student: "\u{1F468}\u200D\u{1F393}",
  woman_student: "\u{1F469}\u200D\u{1F393}",
  teacher: "\u{1F9D1}\u200D\u{1F3EB}",
  man_teacher: "\u{1F468}\u200D\u{1F3EB}",
  woman_teacher: "\u{1F469}\u200D\u{1F3EB}",
  judge: "\u{1F9D1}\u200D\u2696\uFE0F",
  man_judge: "\u{1F468}\u200D\u2696\uFE0F",
  woman_judge: "\u{1F469}\u200D\u2696\uFE0F",
  farmer: "\u{1F9D1}\u200D\u{1F33E}",
  man_farmer: "\u{1F468}\u200D\u{1F33E}",
  woman_farmer: "\u{1F469}\u200D\u{1F33E}",
  cook: "\u{1F9D1}\u200D\u{1F373}",
  man_cook: "\u{1F468}\u200D\u{1F373}",
  woman_cook: "\u{1F469}\u200D\u{1F373}",
  mechanic: "\u{1F9D1}\u200D\u{1F527}",
  man_mechanic: "\u{1F468}\u200D\u{1F527}",
  woman_mechanic: "\u{1F469}\u200D\u{1F527}",
  factory_worker: "\u{1F9D1}\u200D\u{1F3ED}",
  man_factory_worker: "\u{1F468}\u200D\u{1F3ED}",
  woman_factory_worker: "\u{1F469}\u200D\u{1F3ED}",
  office_worker: "\u{1F9D1}\u200D\u{1F4BC}",
  man_office_worker: "\u{1F468}\u200D\u{1F4BC}",
  woman_office_worker: "\u{1F469}\u200D\u{1F4BC}",
  scientist: "\u{1F9D1}\u200D\u{1F52C}",
  man_scientist: "\u{1F468}\u200D\u{1F52C}",
  woman_scientist: "\u{1F469}\u200D\u{1F52C}",
  technologist: "\u{1F9D1}\u200D\u{1F4BB}",
  man_technologist: "\u{1F468}\u200D\u{1F4BB}",
  woman_technologist: "\u{1F469}\u200D\u{1F4BB}",
  singer: "\u{1F9D1}\u200D\u{1F3A4}",
  man_singer: "\u{1F468}\u200D\u{1F3A4}",
  woman_singer: "\u{1F469}\u200D\u{1F3A4}",
  artist: "\u{1F9D1}\u200D\u{1F3A8}",
  man_artist: "\u{1F468}\u200D\u{1F3A8}",
  woman_artist: "\u{1F469}\u200D\u{1F3A8}",
  pilot: "\u{1F9D1}\u200D\u2708\uFE0F",
  man_pilot: "\u{1F468}\u200D\u2708\uFE0F",
  woman_pilot: "\u{1F469}\u200D\u2708\uFE0F",
  astronaut: "\u{1F9D1}\u200D\u{1F680}",
  man_astronaut: "\u{1F468}\u200D\u{1F680}",
  woman_astronaut: "\u{1F469}\u200D\u{1F680}",
  firefighter: "\u{1F9D1}\u200D\u{1F692}",
  man_firefighter: "\u{1F468}\u200D\u{1F692}",
  woman_firefighter: "\u{1F469}\u200D\u{1F692}",
  police_officer: "\u{1F46E}",
  cop: "\u{1F46E}",
  policeman: "\u{1F46E}\u200D\u2642\uFE0F",
  policewoman: "\u{1F46E}\u200D\u2640\uFE0F",
  detective: "\u{1F575}\uFE0F",
  male_detective: "\u{1F575}\uFE0F\u200D\u2642\uFE0F",
  female_detective: "\u{1F575}\uFE0F\u200D\u2640\uFE0F",
  guard: "\u{1F482}",
  guardsman: "\u{1F482}\u200D\u2642\uFE0F",
  guardswoman: "\u{1F482}\u200D\u2640\uFE0F",
  ninja: "\u{1F977}",
  construction_worker: "\u{1F477}",
  construction_worker_man: "\u{1F477}\u200D\u2642\uFE0F",
  construction_worker_woman: "\u{1F477}\u200D\u2640\uFE0F",
  person_with_crown: "\u{1FAC5}",
  prince: "\u{1F934}",
  princess: "\u{1F478}",
  person_with_turban: "\u{1F473}",
  man_with_turban: "\u{1F473}\u200D\u2642\uFE0F",
  woman_with_turban: "\u{1F473}\u200D\u2640\uFE0F",
  man_with_gua_pi_mao: "\u{1F472}",
  woman_with_headscarf: "\u{1F9D5}",
  person_in_tuxedo: "\u{1F935}",
  man_in_tuxedo: "\u{1F935}\u200D\u2642\uFE0F",
  woman_in_tuxedo: "\u{1F935}\u200D\u2640\uFE0F",
  person_with_veil: "\u{1F470}",
  man_with_veil: "\u{1F470}\u200D\u2642\uFE0F",
  woman_with_veil: "\u{1F470}\u200D\u2640\uFE0F",
  bride_with_veil: "\u{1F470}\u200D\u2640\uFE0F",
  pregnant_woman: "\u{1F930}",
  pregnant_man: "\u{1FAC3}",
  pregnant_person: "\u{1FAC4}",
  breast_feeding: "\u{1F931}",
  woman_feeding_baby: "\u{1F469}\u200D\u{1F37C}",
  man_feeding_baby: "\u{1F468}\u200D\u{1F37C}",
  person_feeding_baby: "\u{1F9D1}\u200D\u{1F37C}",
  angel: "\u{1F47C}",
  santa: "\u{1F385}",
  mrs_claus: "\u{1F936}",
  mx_claus: "\u{1F9D1}\u200D\u{1F384}",
  superhero: "\u{1F9B8}",
  superhero_man: "\u{1F9B8}\u200D\u2642\uFE0F",
  superhero_woman: "\u{1F9B8}\u200D\u2640\uFE0F",
  supervillain: "\u{1F9B9}",
  supervillain_man: "\u{1F9B9}\u200D\u2642\uFE0F",
  supervillain_woman: "\u{1F9B9}\u200D\u2640\uFE0F",
  mage: "\u{1F9D9}",
  mage_man: "\u{1F9D9}\u200D\u2642\uFE0F",
  mage_woman: "\u{1F9D9}\u200D\u2640\uFE0F",
  fairy: "\u{1F9DA}",
  fairy_man: "\u{1F9DA}\u200D\u2642\uFE0F",
  fairy_woman: "\u{1F9DA}\u200D\u2640\uFE0F",
  vampire: "\u{1F9DB}",
  vampire_man: "\u{1F9DB}\u200D\u2642\uFE0F",
  vampire_woman: "\u{1F9DB}\u200D\u2640\uFE0F",
  merperson: "\u{1F9DC}",
  merman: "\u{1F9DC}\u200D\u2642\uFE0F",
  mermaid: "\u{1F9DC}\u200D\u2640\uFE0F",
  elf: "\u{1F9DD}",
  elf_man: "\u{1F9DD}\u200D\u2642\uFE0F",
  elf_woman: "\u{1F9DD}\u200D\u2640\uFE0F",
  genie: "\u{1F9DE}",
  genie_man: "\u{1F9DE}\u200D\u2642\uFE0F",
  genie_woman: "\u{1F9DE}\u200D\u2640\uFE0F",
  zombie: "\u{1F9DF}",
  zombie_man: "\u{1F9DF}\u200D\u2642\uFE0F",
  zombie_woman: "\u{1F9DF}\u200D\u2640\uFE0F",
  troll: "\u{1F9CC}",
  massage: "\u{1F486}",
  massage_man: "\u{1F486}\u200D\u2642\uFE0F",
  massage_woman: "\u{1F486}\u200D\u2640\uFE0F",
  haircut: "\u{1F487}",
  haircut_man: "\u{1F487}\u200D\u2642\uFE0F",
  haircut_woman: "\u{1F487}\u200D\u2640\uFE0F",
  walking: "\u{1F6B6}",
  walking_man: "\u{1F6B6}\u200D\u2642\uFE0F",
  walking_woman: "\u{1F6B6}\u200D\u2640\uFE0F",
  standing_person: "\u{1F9CD}",
  standing_man: "\u{1F9CD}\u200D\u2642\uFE0F",
  standing_woman: "\u{1F9CD}\u200D\u2640\uFE0F",
  kneeling_person: "\u{1F9CE}",
  kneeling_man: "\u{1F9CE}\u200D\u2642\uFE0F",
  kneeling_woman: "\u{1F9CE}\u200D\u2640\uFE0F",
  person_with_probing_cane: "\u{1F9D1}\u200D\u{1F9AF}",
  man_with_probing_cane: "\u{1F468}\u200D\u{1F9AF}",
  woman_with_probing_cane: "\u{1F469}\u200D\u{1F9AF}",
  person_in_motorized_wheelchair: "\u{1F9D1}\u200D\u{1F9BC}",
  man_in_motorized_wheelchair: "\u{1F468}\u200D\u{1F9BC}",
  woman_in_motorized_wheelchair: "\u{1F469}\u200D\u{1F9BC}",
  person_in_manual_wheelchair: "\u{1F9D1}\u200D\u{1F9BD}",
  man_in_manual_wheelchair: "\u{1F468}\u200D\u{1F9BD}",
  woman_in_manual_wheelchair: "\u{1F469}\u200D\u{1F9BD}",
  runner: "\u{1F3C3}",
  running: "\u{1F3C3}",
  running_man: "\u{1F3C3}\u200D\u2642\uFE0F",
  running_woman: "\u{1F3C3}\u200D\u2640\uFE0F",
  woman_dancing: "\u{1F483}",
  dancer: "\u{1F483}",
  man_dancing: "\u{1F57A}",
  business_suit_levitating: "\u{1F574}\uFE0F",
  dancers: "\u{1F46F}",
  dancing_men: "\u{1F46F}\u200D\u2642\uFE0F",
  dancing_women: "\u{1F46F}\u200D\u2640\uFE0F",
  sauna_person: "\u{1F9D6}",
  sauna_man: "\u{1F9D6}\u200D\u2642\uFE0F",
  sauna_woman: "\u{1F9D6}\u200D\u2640\uFE0F",
  climbing: "\u{1F9D7}",
  climbing_man: "\u{1F9D7}\u200D\u2642\uFE0F",
  climbing_woman: "\u{1F9D7}\u200D\u2640\uFE0F",
  person_fencing: "\u{1F93A}",
  horse_racing: "\u{1F3C7}",
  skier: "\u26F7\uFE0F",
  snowboarder: "\u{1F3C2}",
  golfing: "\u{1F3CC}\uFE0F",
  golfing_man: "\u{1F3CC}\uFE0F\u200D\u2642\uFE0F",
  golfing_woman: "\u{1F3CC}\uFE0F\u200D\u2640\uFE0F",
  surfer: "\u{1F3C4}",
  surfing_man: "\u{1F3C4}\u200D\u2642\uFE0F",
  surfing_woman: "\u{1F3C4}\u200D\u2640\uFE0F",
  rowboat: "\u{1F6A3}",
  rowing_man: "\u{1F6A3}\u200D\u2642\uFE0F",
  rowing_woman: "\u{1F6A3}\u200D\u2640\uFE0F",
  swimmer: "\u{1F3CA}",
  swimming_man: "\u{1F3CA}\u200D\u2642\uFE0F",
  swimming_woman: "\u{1F3CA}\u200D\u2640\uFE0F",
  bouncing_ball_person: "\u26F9\uFE0F",
  bouncing_ball_man: "\u26F9\uFE0F\u200D\u2642\uFE0F",
  basketball_man: "\u26F9\uFE0F\u200D\u2642\uFE0F",
  bouncing_ball_woman: "\u26F9\uFE0F\u200D\u2640\uFE0F",
  basketball_woman: "\u26F9\uFE0F\u200D\u2640\uFE0F",
  weight_lifting: "\u{1F3CB}\uFE0F",
  weight_lifting_man: "\u{1F3CB}\uFE0F\u200D\u2642\uFE0F",
  weight_lifting_woman: "\u{1F3CB}\uFE0F\u200D\u2640\uFE0F",
  bicyclist: "\u{1F6B4}",
  biking_man: "\u{1F6B4}\u200D\u2642\uFE0F",
  biking_woman: "\u{1F6B4}\u200D\u2640\uFE0F",
  mountain_bicyclist: "\u{1F6B5}",
  mountain_biking_man: "\u{1F6B5}\u200D\u2642\uFE0F",
  mountain_biking_woman: "\u{1F6B5}\u200D\u2640\uFE0F",
  cartwheeling: "\u{1F938}",
  man_cartwheeling: "\u{1F938}\u200D\u2642\uFE0F",
  woman_cartwheeling: "\u{1F938}\u200D\u2640\uFE0F",
  wrestling: "\u{1F93C}",
  men_wrestling: "\u{1F93C}\u200D\u2642\uFE0F",
  women_wrestling: "\u{1F93C}\u200D\u2640\uFE0F",
  water_polo: "\u{1F93D}",
  man_playing_water_polo: "\u{1F93D}\u200D\u2642\uFE0F",
  woman_playing_water_polo: "\u{1F93D}\u200D\u2640\uFE0F",
  handball_person: "\u{1F93E}",
  man_playing_handball: "\u{1F93E}\u200D\u2642\uFE0F",
  woman_playing_handball: "\u{1F93E}\u200D\u2640\uFE0F",
  juggling_person: "\u{1F939}",
  man_juggling: "\u{1F939}\u200D\u2642\uFE0F",
  woman_juggling: "\u{1F939}\u200D\u2640\uFE0F",
  lotus_position: "\u{1F9D8}",
  lotus_position_man: "\u{1F9D8}\u200D\u2642\uFE0F",
  lotus_position_woman: "\u{1F9D8}\u200D\u2640\uFE0F",
  bath: "\u{1F6C0}",
  sleeping_bed: "\u{1F6CC}",
  people_holding_hands: "\u{1F9D1}\u200D\u{1F91D}\u200D\u{1F9D1}",
  two_women_holding_hands: "\u{1F46D}",
  couple: "\u{1F46B}",
  two_men_holding_hands: "\u{1F46C}",
  couplekiss: "\u{1F48F}",
  couplekiss_man_woman: "\u{1F469}\u200D\u2764\uFE0F\u200D\u{1F48B}\u200D\u{1F468}",
  couplekiss_man_man: "\u{1F468}\u200D\u2764\uFE0F\u200D\u{1F48B}\u200D\u{1F468}",
  couplekiss_woman_woman: "\u{1F469}\u200D\u2764\uFE0F\u200D\u{1F48B}\u200D\u{1F469}",
  couple_with_heart: "\u{1F491}",
  couple_with_heart_woman_man: "\u{1F469}\u200D\u2764\uFE0F\u200D\u{1F468}",
  couple_with_heart_man_man: "\u{1F468}\u200D\u2764\uFE0F\u200D\u{1F468}",
  couple_with_heart_woman_woman: "\u{1F469}\u200D\u2764\uFE0F\u200D\u{1F469}",
  family: "\u{1F46A}",
  family_man_woman_boy: "\u{1F468}\u200D\u{1F469}\u200D\u{1F466}",
  family_man_woman_girl: "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}",
  family_man_woman_girl_boy: "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}\u200D\u{1F466}",
  family_man_woman_boy_boy: "\u{1F468}\u200D\u{1F469}\u200D\u{1F466}\u200D\u{1F466}",
  family_man_woman_girl_girl: "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}\u200D\u{1F467}",
  family_man_man_boy: "\u{1F468}\u200D\u{1F468}\u200D\u{1F466}",
  family_man_man_girl: "\u{1F468}\u200D\u{1F468}\u200D\u{1F467}",
  family_man_man_girl_boy: "\u{1F468}\u200D\u{1F468}\u200D\u{1F467}\u200D\u{1F466}",
  family_man_man_boy_boy: "\u{1F468}\u200D\u{1F468}\u200D\u{1F466}\u200D\u{1F466}",
  family_man_man_girl_girl: "\u{1F468}\u200D\u{1F468}\u200D\u{1F467}\u200D\u{1F467}",
  family_woman_woman_boy: "\u{1F469}\u200D\u{1F469}\u200D\u{1F466}",
  family_woman_woman_girl: "\u{1F469}\u200D\u{1F469}\u200D\u{1F467}",
  family_woman_woman_girl_boy: "\u{1F469}\u200D\u{1F469}\u200D\u{1F467}\u200D\u{1F466}",
  family_woman_woman_boy_boy: "\u{1F469}\u200D\u{1F469}\u200D\u{1F466}\u200D\u{1F466}",
  family_woman_woman_girl_girl: "\u{1F469}\u200D\u{1F469}\u200D\u{1F467}\u200D\u{1F467}",
  family_man_boy: "\u{1F468}\u200D\u{1F466}",
  family_man_boy_boy: "\u{1F468}\u200D\u{1F466}\u200D\u{1F466}",
  family_man_girl: "\u{1F468}\u200D\u{1F467}",
  family_man_girl_boy: "\u{1F468}\u200D\u{1F467}\u200D\u{1F466}",
  family_man_girl_girl: "\u{1F468}\u200D\u{1F467}\u200D\u{1F467}",
  family_woman_boy: "\u{1F469}\u200D\u{1F466}",
  family_woman_boy_boy: "\u{1F469}\u200D\u{1F466}\u200D\u{1F466}",
  family_woman_girl: "\u{1F469}\u200D\u{1F467}",
  family_woman_girl_boy: "\u{1F469}\u200D\u{1F467}\u200D\u{1F466}",
  family_woman_girl_girl: "\u{1F469}\u200D\u{1F467}\u200D\u{1F467}",
  speaking_head: "\u{1F5E3}\uFE0F",
  bust_in_silhouette: "\u{1F464}",
  busts_in_silhouette: "\u{1F465}",
  people_hugging: "\u{1FAC2}",
  footprints: "\u{1F463}",
  monkey_face: "\u{1F435}",
  monkey: "\u{1F412}",
  gorilla: "\u{1F98D}",
  orangutan: "\u{1F9A7}",
  dog: "\u{1F436}",
  dog2: "\u{1F415}",
  guide_dog: "\u{1F9AE}",
  service_dog: "\u{1F415}\u200D\u{1F9BA}",
  poodle: "\u{1F429}",
  wolf: "\u{1F43A}",
  fox_face: "\u{1F98A}",
  raccoon: "\u{1F99D}",
  cat: "\u{1F431}",
  cat2: "\u{1F408}",
  black_cat: "\u{1F408}\u200D\u2B1B",
  lion: "\u{1F981}",
  tiger: "\u{1F42F}",
  tiger2: "\u{1F405}",
  leopard: "\u{1F406}",
  horse: "\u{1F434}",
  moose: "\u{1FACE}",
  donkey: "\u{1FACF}",
  racehorse: "\u{1F40E}",
  unicorn: "\u{1F984}",
  zebra: "\u{1F993}",
  deer: "\u{1F98C}",
  bison: "\u{1F9AC}",
  cow: "\u{1F42E}",
  ox: "\u{1F402}",
  water_buffalo: "\u{1F403}",
  cow2: "\u{1F404}",
  pig: "\u{1F437}",
  pig2: "\u{1F416}",
  boar: "\u{1F417}",
  pig_nose: "\u{1F43D}",
  ram: "\u{1F40F}",
  sheep: "\u{1F411}",
  goat: "\u{1F410}",
  dromedary_camel: "\u{1F42A}",
  camel: "\u{1F42B}",
  llama: "\u{1F999}",
  giraffe: "\u{1F992}",
  elephant: "\u{1F418}",
  mammoth: "\u{1F9A3}",
  rhinoceros: "\u{1F98F}",
  hippopotamus: "\u{1F99B}",
  mouse: "\u{1F42D}",
  mouse2: "\u{1F401}",
  rat: "\u{1F400}",
  hamster: "\u{1F439}",
  rabbit: "\u{1F430}",
  rabbit2: "\u{1F407}",
  chipmunk: "\u{1F43F}\uFE0F",
  beaver: "\u{1F9AB}",
  hedgehog: "\u{1F994}",
  bat: "\u{1F987}",
  bear: "\u{1F43B}",
  polar_bear: "\u{1F43B}\u200D\u2744\uFE0F",
  koala: "\u{1F428}",
  panda_face: "\u{1F43C}",
  sloth: "\u{1F9A5}",
  otter: "\u{1F9A6}",
  skunk: "\u{1F9A8}",
  kangaroo: "\u{1F998}",
  badger: "\u{1F9A1}",
  feet: "\u{1F43E}",
  paw_prints: "\u{1F43E}",
  turkey: "\u{1F983}",
  chicken: "\u{1F414}",
  rooster: "\u{1F413}",
  hatching_chick: "\u{1F423}",
  baby_chick: "\u{1F424}",
  hatched_chick: "\u{1F425}",
  bird: "\u{1F426}",
  penguin: "\u{1F427}",
  dove: "\u{1F54A}\uFE0F",
  eagle: "\u{1F985}",
  duck: "\u{1F986}",
  swan: "\u{1F9A2}",
  owl: "\u{1F989}",
  dodo: "\u{1F9A4}",
  feather: "\u{1FAB6}",
  flamingo: "\u{1F9A9}",
  peacock: "\u{1F99A}",
  parrot: "\u{1F99C}",
  wing: "\u{1FABD}",
  black_bird: "\u{1F426}\u200D\u2B1B",
  goose: "\u{1FABF}",
  frog: "\u{1F438}",
  crocodile: "\u{1F40A}",
  turtle: "\u{1F422}",
  lizard: "\u{1F98E}",
  snake: "\u{1F40D}",
  dragon_face: "\u{1F432}",
  dragon: "\u{1F409}",
  sauropod: "\u{1F995}",
  "t-rex": "\u{1F996}",
  whale: "\u{1F433}",
  whale2: "\u{1F40B}",
  dolphin: "\u{1F42C}",
  flipper: "\u{1F42C}",
  seal: "\u{1F9AD}",
  fish: "\u{1F41F}",
  tropical_fish: "\u{1F420}",
  blowfish: "\u{1F421}",
  shark: "\u{1F988}",
  octopus: "\u{1F419}",
  shell: "\u{1F41A}",
  coral: "\u{1FAB8}",
  jellyfish: "\u{1FABC}",
  snail: "\u{1F40C}",
  butterfly: "\u{1F98B}",
  bug: "\u{1F41B}",
  ant: "\u{1F41C}",
  bee: "\u{1F41D}",
  honeybee: "\u{1F41D}",
  beetle: "\u{1FAB2}",
  lady_beetle: "\u{1F41E}",
  cricket: "\u{1F997}",
  cockroach: "\u{1FAB3}",
  spider: "\u{1F577}\uFE0F",
  spider_web: "\u{1F578}\uFE0F",
  scorpion: "\u{1F982}",
  mosquito: "\u{1F99F}",
  fly: "\u{1FAB0}",
  worm: "\u{1FAB1}",
  microbe: "\u{1F9A0}",
  bouquet: "\u{1F490}",
  cherry_blossom: "\u{1F338}",
  white_flower: "\u{1F4AE}",
  lotus: "\u{1FAB7}",
  rosette: "\u{1F3F5}\uFE0F",
  rose: "\u{1F339}",
  wilted_flower: "\u{1F940}",
  hibiscus: "\u{1F33A}",
  sunflower: "\u{1F33B}",
  blossom: "\u{1F33C}",
  tulip: "\u{1F337}",
  hyacinth: "\u{1FABB}",
  seedling: "\u{1F331}",
  potted_plant: "\u{1FAB4}",
  evergreen_tree: "\u{1F332}",
  deciduous_tree: "\u{1F333}",
  palm_tree: "\u{1F334}",
  cactus: "\u{1F335}",
  ear_of_rice: "\u{1F33E}",
  herb: "\u{1F33F}",
  shamrock: "\u2618\uFE0F",
  four_leaf_clover: "\u{1F340}",
  maple_leaf: "\u{1F341}",
  fallen_leaf: "\u{1F342}",
  leaves: "\u{1F343}",
  empty_nest: "\u{1FAB9}",
  nest_with_eggs: "\u{1FABA}",
  mushroom: "\u{1F344}",
  grapes: "\u{1F347}",
  melon: "\u{1F348}",
  watermelon: "\u{1F349}",
  tangerine: "\u{1F34A}",
  orange: "\u{1F34A}",
  mandarin: "\u{1F34A}",
  lemon: "\u{1F34B}",
  banana: "\u{1F34C}",
  pineapple: "\u{1F34D}",
  mango: "\u{1F96D}",
  apple: "\u{1F34E}",
  green_apple: "\u{1F34F}",
  pear: "\u{1F350}",
  peach: "\u{1F351}",
  cherries: "\u{1F352}",
  strawberry: "\u{1F353}",
  blueberries: "\u{1FAD0}",
  kiwi_fruit: "\u{1F95D}",
  tomato: "\u{1F345}",
  olive: "\u{1FAD2}",
  coconut: "\u{1F965}",
  avocado: "\u{1F951}",
  eggplant: "\u{1F346}",
  potato: "\u{1F954}",
  carrot: "\u{1F955}",
  corn: "\u{1F33D}",
  hot_pepper: "\u{1F336}\uFE0F",
  bell_pepper: "\u{1FAD1}",
  cucumber: "\u{1F952}",
  leafy_green: "\u{1F96C}",
  broccoli: "\u{1F966}",
  garlic: "\u{1F9C4}",
  onion: "\u{1F9C5}",
  peanuts: "\u{1F95C}",
  beans: "\u{1FAD8}",
  chestnut: "\u{1F330}",
  ginger_root: "\u{1FADA}",
  pea_pod: "\u{1FADB}",
  bread: "\u{1F35E}",
  croissant: "\u{1F950}",
  baguette_bread: "\u{1F956}",
  flatbread: "\u{1FAD3}",
  pretzel: "\u{1F968}",
  bagel: "\u{1F96F}",
  pancakes: "\u{1F95E}",
  waffle: "\u{1F9C7}",
  cheese: "\u{1F9C0}",
  meat_on_bone: "\u{1F356}",
  poultry_leg: "\u{1F357}",
  cut_of_meat: "\u{1F969}",
  bacon: "\u{1F953}",
  hamburger: "\u{1F354}",
  fries: "\u{1F35F}",
  pizza: "\u{1F355}",
  hotdog: "\u{1F32D}",
  sandwich: "\u{1F96A}",
  taco: "\u{1F32E}",
  burrito: "\u{1F32F}",
  tamale: "\u{1FAD4}",
  stuffed_flatbread: "\u{1F959}",
  falafel: "\u{1F9C6}",
  egg: "\u{1F95A}",
  fried_egg: "\u{1F373}",
  shallow_pan_of_food: "\u{1F958}",
  stew: "\u{1F372}",
  fondue: "\u{1FAD5}",
  bowl_with_spoon: "\u{1F963}",
  green_salad: "\u{1F957}",
  popcorn: "\u{1F37F}",
  butter: "\u{1F9C8}",
  salt: "\u{1F9C2}",
  canned_food: "\u{1F96B}",
  bento: "\u{1F371}",
  rice_cracker: "\u{1F358}",
  rice_ball: "\u{1F359}",
  rice: "\u{1F35A}",
  curry: "\u{1F35B}",
  ramen: "\u{1F35C}",
  spaghetti: "\u{1F35D}",
  sweet_potato: "\u{1F360}",
  oden: "\u{1F362}",
  sushi: "\u{1F363}",
  fried_shrimp: "\u{1F364}",
  fish_cake: "\u{1F365}",
  moon_cake: "\u{1F96E}",
  dango: "\u{1F361}",
  dumpling: "\u{1F95F}",
  fortune_cookie: "\u{1F960}",
  takeout_box: "\u{1F961}",
  crab: "\u{1F980}",
  lobster: "\u{1F99E}",
  shrimp: "\u{1F990}",
  squid: "\u{1F991}",
  oyster: "\u{1F9AA}",
  icecream: "\u{1F366}",
  shaved_ice: "\u{1F367}",
  ice_cream: "\u{1F368}",
  doughnut: "\u{1F369}",
  cookie: "\u{1F36A}",
  birthday: "\u{1F382}",
  cake: "\u{1F370}",
  cupcake: "\u{1F9C1}",
  pie: "\u{1F967}",
  chocolate_bar: "\u{1F36B}",
  candy: "\u{1F36C}",
  lollipop: "\u{1F36D}",
  custard: "\u{1F36E}",
  honey_pot: "\u{1F36F}",
  baby_bottle: "\u{1F37C}",
  milk_glass: "\u{1F95B}",
  coffee: "\u2615",
  teapot: "\u{1FAD6}",
  tea: "\u{1F375}",
  sake: "\u{1F376}",
  champagne: "\u{1F37E}",
  wine_glass: "\u{1F377}",
  cocktail: "\u{1F378}",
  tropical_drink: "\u{1F379}",
  beer: "\u{1F37A}",
  beers: "\u{1F37B}",
  clinking_glasses: "\u{1F942}",
  tumbler_glass: "\u{1F943}",
  pouring_liquid: "\u{1FAD7}",
  cup_with_straw: "\u{1F964}",
  bubble_tea: "\u{1F9CB}",
  beverage_box: "\u{1F9C3}",
  mate: "\u{1F9C9}",
  ice_cube: "\u{1F9CA}",
  chopsticks: "\u{1F962}",
  plate_with_cutlery: "\u{1F37D}\uFE0F",
  fork_and_knife: "\u{1F374}",
  spoon: "\u{1F944}",
  hocho: "\u{1F52A}",
  knife: "\u{1F52A}",
  jar: "\u{1FAD9}",
  amphora: "\u{1F3FA}",
  earth_africa: "\u{1F30D}",
  earth_americas: "\u{1F30E}",
  earth_asia: "\u{1F30F}",
  globe_with_meridians: "\u{1F310}",
  world_map: "\u{1F5FA}\uFE0F",
  japan: "\u{1F5FE}",
  compass: "\u{1F9ED}",
  mountain_snow: "\u{1F3D4}\uFE0F",
  mountain: "\u26F0\uFE0F",
  volcano: "\u{1F30B}",
  mount_fuji: "\u{1F5FB}",
  camping: "\u{1F3D5}\uFE0F",
  beach_umbrella: "\u{1F3D6}\uFE0F",
  desert: "\u{1F3DC}\uFE0F",
  desert_island: "\u{1F3DD}\uFE0F",
  national_park: "\u{1F3DE}\uFE0F",
  stadium: "\u{1F3DF}\uFE0F",
  classical_building: "\u{1F3DB}\uFE0F",
  building_construction: "\u{1F3D7}\uFE0F",
  bricks: "\u{1F9F1}",
  rock: "\u{1FAA8}",
  wood: "\u{1FAB5}",
  hut: "\u{1F6D6}",
  houses: "\u{1F3D8}\uFE0F",
  derelict_house: "\u{1F3DA}\uFE0F",
  house: "\u{1F3E0}",
  house_with_garden: "\u{1F3E1}",
  office: "\u{1F3E2}",
  post_office: "\u{1F3E3}",
  european_post_office: "\u{1F3E4}",
  hospital: "\u{1F3E5}",
  bank: "\u{1F3E6}",
  hotel: "\u{1F3E8}",
  love_hotel: "\u{1F3E9}",
  convenience_store: "\u{1F3EA}",
  school: "\u{1F3EB}",
  department_store: "\u{1F3EC}",
  factory: "\u{1F3ED}",
  japanese_castle: "\u{1F3EF}",
  european_castle: "\u{1F3F0}",
  wedding: "\u{1F492}",
  tokyo_tower: "\u{1F5FC}",
  statue_of_liberty: "\u{1F5FD}",
  church: "\u26EA",
  mosque: "\u{1F54C}",
  hindu_temple: "\u{1F6D5}",
  synagogue: "\u{1F54D}",
  shinto_shrine: "\u26E9\uFE0F",
  kaaba: "\u{1F54B}",
  fountain: "\u26F2",
  tent: "\u26FA",
  foggy: "\u{1F301}",
  night_with_stars: "\u{1F303}",
  cityscape: "\u{1F3D9}\uFE0F",
  sunrise_over_mountains: "\u{1F304}",
  sunrise: "\u{1F305}",
  city_sunset: "\u{1F306}",
  city_sunrise: "\u{1F307}",
  bridge_at_night: "\u{1F309}",
  hotsprings: "\u2668\uFE0F",
  carousel_horse: "\u{1F3A0}",
  playground_slide: "\u{1F6DD}",
  ferris_wheel: "\u{1F3A1}",
  roller_coaster: "\u{1F3A2}",
  barber: "\u{1F488}",
  circus_tent: "\u{1F3AA}",
  steam_locomotive: "\u{1F682}",
  railway_car: "\u{1F683}",
  bullettrain_side: "\u{1F684}",
  bullettrain_front: "\u{1F685}",
  train2: "\u{1F686}",
  metro: "\u{1F687}",
  light_rail: "\u{1F688}",
  station: "\u{1F689}",
  tram: "\u{1F68A}",
  monorail: "\u{1F69D}",
  mountain_railway: "\u{1F69E}",
  train: "\u{1F68B}",
  bus: "\u{1F68C}",
  oncoming_bus: "\u{1F68D}",
  trolleybus: "\u{1F68E}",
  minibus: "\u{1F690}",
  ambulance: "\u{1F691}",
  fire_engine: "\u{1F692}",
  police_car: "\u{1F693}",
  oncoming_police_car: "\u{1F694}",
  taxi: "\u{1F695}",
  oncoming_taxi: "\u{1F696}",
  car: "\u{1F697}",
  red_car: "\u{1F697}",
  oncoming_automobile: "\u{1F698}",
  blue_car: "\u{1F699}",
  pickup_truck: "\u{1F6FB}",
  truck: "\u{1F69A}",
  articulated_lorry: "\u{1F69B}",
  tractor: "\u{1F69C}",
  racing_car: "\u{1F3CE}\uFE0F",
  motorcycle: "\u{1F3CD}\uFE0F",
  motor_scooter: "\u{1F6F5}",
  manual_wheelchair: "\u{1F9BD}",
  motorized_wheelchair: "\u{1F9BC}",
  auto_rickshaw: "\u{1F6FA}",
  bike: "\u{1F6B2}",
  kick_scooter: "\u{1F6F4}",
  skateboard: "\u{1F6F9}",
  roller_skate: "\u{1F6FC}",
  busstop: "\u{1F68F}",
  motorway: "\u{1F6E3}\uFE0F",
  railway_track: "\u{1F6E4}\uFE0F",
  oil_drum: "\u{1F6E2}\uFE0F",
  fuelpump: "\u26FD",
  wheel: "\u{1F6DE}",
  rotating_light: "\u{1F6A8}",
  traffic_light: "\u{1F6A5}",
  vertical_traffic_light: "\u{1F6A6}",
  stop_sign: "\u{1F6D1}",
  construction: "\u{1F6A7}",
  anchor: "\u2693",
  ring_buoy: "\u{1F6DF}",
  boat: "\u26F5",
  sailboat: "\u26F5",
  canoe: "\u{1F6F6}",
  speedboat: "\u{1F6A4}",
  passenger_ship: "\u{1F6F3}\uFE0F",
  ferry: "\u26F4\uFE0F",
  motor_boat: "\u{1F6E5}\uFE0F",
  ship: "\u{1F6A2}",
  airplane: "\u2708\uFE0F",
  small_airplane: "\u{1F6E9}\uFE0F",
  flight_departure: "\u{1F6EB}",
  flight_arrival: "\u{1F6EC}",
  parachute: "\u{1FA82}",
  seat: "\u{1F4BA}",
  helicopter: "\u{1F681}",
  suspension_railway: "\u{1F69F}",
  mountain_cableway: "\u{1F6A0}",
  aerial_tramway: "\u{1F6A1}",
  artificial_satellite: "\u{1F6F0}\uFE0F",
  rocket: "\u{1F680}",
  flying_saucer: "\u{1F6F8}",
  bellhop_bell: "\u{1F6CE}\uFE0F",
  luggage: "\u{1F9F3}",
  hourglass: "\u231B",
  hourglass_flowing_sand: "\u23F3",
  watch: "\u231A",
  alarm_clock: "\u23F0",
  stopwatch: "\u23F1\uFE0F",
  timer_clock: "\u23F2\uFE0F",
  mantelpiece_clock: "\u{1F570}\uFE0F",
  clock12: "\u{1F55B}",
  clock1230: "\u{1F567}",
  clock1: "\u{1F550}",
  clock130: "\u{1F55C}",
  clock2: "\u{1F551}",
  clock230: "\u{1F55D}",
  clock3: "\u{1F552}",
  clock330: "\u{1F55E}",
  clock4: "\u{1F553}",
  clock430: "\u{1F55F}",
  clock5: "\u{1F554}",
  clock530: "\u{1F560}",
  clock6: "\u{1F555}",
  clock630: "\u{1F561}",
  clock7: "\u{1F556}",
  clock730: "\u{1F562}",
  clock8: "\u{1F557}",
  clock830: "\u{1F563}",
  clock9: "\u{1F558}",
  clock930: "\u{1F564}",
  clock10: "\u{1F559}",
  clock1030: "\u{1F565}",
  clock11: "\u{1F55A}",
  clock1130: "\u{1F566}",
  new_moon: "\u{1F311}",
  waxing_crescent_moon: "\u{1F312}",
  first_quarter_moon: "\u{1F313}",
  moon: "\u{1F314}",
  waxing_gibbous_moon: "\u{1F314}",
  full_moon: "\u{1F315}",
  waning_gibbous_moon: "\u{1F316}",
  last_quarter_moon: "\u{1F317}",
  waning_crescent_moon: "\u{1F318}",
  crescent_moon: "\u{1F319}",
  new_moon_with_face: "\u{1F31A}",
  first_quarter_moon_with_face: "\u{1F31B}",
  last_quarter_moon_with_face: "\u{1F31C}",
  thermometer: "\u{1F321}\uFE0F",
  sunny: "\u2600\uFE0F",
  full_moon_with_face: "\u{1F31D}",
  sun_with_face: "\u{1F31E}",
  ringed_planet: "\u{1FA90}",
  star: "\u2B50",
  star2: "\u{1F31F}",
  stars: "\u{1F320}",
  milky_way: "\u{1F30C}",
  cloud: "\u2601\uFE0F",
  partly_sunny: "\u26C5",
  cloud_with_lightning_and_rain: "\u26C8\uFE0F",
  sun_behind_small_cloud: "\u{1F324}\uFE0F",
  sun_behind_large_cloud: "\u{1F325}\uFE0F",
  sun_behind_rain_cloud: "\u{1F326}\uFE0F",
  cloud_with_rain: "\u{1F327}\uFE0F",
  cloud_with_snow: "\u{1F328}\uFE0F",
  cloud_with_lightning: "\u{1F329}\uFE0F",
  tornado: "\u{1F32A}\uFE0F",
  fog: "\u{1F32B}\uFE0F",
  wind_face: "\u{1F32C}\uFE0F",
  cyclone: "\u{1F300}",
  rainbow: "\u{1F308}",
  closed_umbrella: "\u{1F302}",
  open_umbrella: "\u2602\uFE0F",
  umbrella: "\u2614",
  parasol_on_ground: "\u26F1\uFE0F",
  zap: "\u26A1",
  snowflake: "\u2744\uFE0F",
  snowman_with_snow: "\u2603\uFE0F",
  snowman: "\u26C4",
  comet: "\u2604\uFE0F",
  fire: "\u{1F525}",
  droplet: "\u{1F4A7}",
  ocean: "\u{1F30A}",
  jack_o_lantern: "\u{1F383}",
  christmas_tree: "\u{1F384}",
  fireworks: "\u{1F386}",
  sparkler: "\u{1F387}",
  firecracker: "\u{1F9E8}",
  sparkles: "\u2728",
  balloon: "\u{1F388}",
  tada: "\u{1F389}",
  confetti_ball: "\u{1F38A}",
  tanabata_tree: "\u{1F38B}",
  bamboo: "\u{1F38D}",
  dolls: "\u{1F38E}",
  flags: "\u{1F38F}",
  wind_chime: "\u{1F390}",
  rice_scene: "\u{1F391}",
  red_envelope: "\u{1F9E7}",
  ribbon: "\u{1F380}",
  gift: "\u{1F381}",
  reminder_ribbon: "\u{1F397}\uFE0F",
  tickets: "\u{1F39F}\uFE0F",
  ticket: "\u{1F3AB}",
  medal_military: "\u{1F396}\uFE0F",
  trophy: "\u{1F3C6}",
  medal_sports: "\u{1F3C5}",
  "1st_place_medal": "\u{1F947}",
  "2nd_place_medal": "\u{1F948}",
  "3rd_place_medal": "\u{1F949}",
  soccer: "\u26BD",
  baseball: "\u26BE",
  softball: "\u{1F94E}",
  basketball: "\u{1F3C0}",
  volleyball: "\u{1F3D0}",
  football: "\u{1F3C8}",
  rugby_football: "\u{1F3C9}",
  tennis: "\u{1F3BE}",
  flying_disc: "\u{1F94F}",
  bowling: "\u{1F3B3}",
  cricket_game: "\u{1F3CF}",
  field_hockey: "\u{1F3D1}",
  ice_hockey: "\u{1F3D2}",
  lacrosse: "\u{1F94D}",
  ping_pong: "\u{1F3D3}",
  badminton: "\u{1F3F8}",
  boxing_glove: "\u{1F94A}",
  martial_arts_uniform: "\u{1F94B}",
  goal_net: "\u{1F945}",
  golf: "\u26F3",
  ice_skate: "\u26F8\uFE0F",
  fishing_pole_and_fish: "\u{1F3A3}",
  diving_mask: "\u{1F93F}",
  running_shirt_with_sash: "\u{1F3BD}",
  ski: "\u{1F3BF}",
  sled: "\u{1F6F7}",
  curling_stone: "\u{1F94C}",
  dart: "\u{1F3AF}",
  yo_yo: "\u{1FA80}",
  kite: "\u{1FA81}",
  gun: "\u{1F52B}",
  "8ball": "\u{1F3B1}",
  crystal_ball: "\u{1F52E}",
  magic_wand: "\u{1FA84}",
  video_game: "\u{1F3AE}",
  joystick: "\u{1F579}\uFE0F",
  slot_machine: "\u{1F3B0}",
  game_die: "\u{1F3B2}",
  jigsaw: "\u{1F9E9}",
  teddy_bear: "\u{1F9F8}",
  pinata: "\u{1FA85}",
  mirror_ball: "\u{1FAA9}",
  nesting_dolls: "\u{1FA86}",
  spades: "\u2660\uFE0F",
  hearts: "\u2665\uFE0F",
  diamonds: "\u2666\uFE0F",
  clubs: "\u2663\uFE0F",
  chess_pawn: "\u265F\uFE0F",
  black_joker: "\u{1F0CF}",
  mahjong: "\u{1F004}",
  flower_playing_cards: "\u{1F3B4}",
  performing_arts: "\u{1F3AD}",
  framed_picture: "\u{1F5BC}\uFE0F",
  art: "\u{1F3A8}",
  thread: "\u{1F9F5}",
  sewing_needle: "\u{1FAA1}",
  yarn: "\u{1F9F6}",
  knot: "\u{1FAA2}",
  eyeglasses: "\u{1F453}",
  dark_sunglasses: "\u{1F576}\uFE0F",
  goggles: "\u{1F97D}",
  lab_coat: "\u{1F97C}",
  safety_vest: "\u{1F9BA}",
  necktie: "\u{1F454}",
  shirt: "\u{1F455}",
  tshirt: "\u{1F455}",
  jeans: "\u{1F456}",
  scarf: "\u{1F9E3}",
  gloves: "\u{1F9E4}",
  coat: "\u{1F9E5}",
  socks: "\u{1F9E6}",
  dress: "\u{1F457}",
  kimono: "\u{1F458}",
  sari: "\u{1F97B}",
  one_piece_swimsuit: "\u{1FA71}",
  swim_brief: "\u{1FA72}",
  shorts: "\u{1FA73}",
  bikini: "\u{1F459}",
  womans_clothes: "\u{1F45A}",
  folding_hand_fan: "\u{1FAAD}",
  purse: "\u{1F45B}",
  handbag: "\u{1F45C}",
  pouch: "\u{1F45D}",
  shopping: "\u{1F6CD}\uFE0F",
  school_satchel: "\u{1F392}",
  thong_sandal: "\u{1FA74}",
  mans_shoe: "\u{1F45E}",
  shoe: "\u{1F45E}",
  athletic_shoe: "\u{1F45F}",
  hiking_boot: "\u{1F97E}",
  flat_shoe: "\u{1F97F}",
  high_heel: "\u{1F460}",
  sandal: "\u{1F461}",
  ballet_shoes: "\u{1FA70}",
  boot: "\u{1F462}",
  hair_pick: "\u{1FAAE}",
  crown: "\u{1F451}",
  womans_hat: "\u{1F452}",
  tophat: "\u{1F3A9}",
  mortar_board: "\u{1F393}",
  billed_cap: "\u{1F9E2}",
  military_helmet: "\u{1FA96}",
  rescue_worker_helmet: "\u26D1\uFE0F",
  prayer_beads: "\u{1F4FF}",
  lipstick: "\u{1F484}",
  ring: "\u{1F48D}",
  gem: "\u{1F48E}",
  mute: "\u{1F507}",
  speaker: "\u{1F508}",
  sound: "\u{1F509}",
  loud_sound: "\u{1F50A}",
  loudspeaker: "\u{1F4E2}",
  mega: "\u{1F4E3}",
  postal_horn: "\u{1F4EF}",
  bell: "\u{1F514}",
  no_bell: "\u{1F515}",
  musical_score: "\u{1F3BC}",
  musical_note: "\u{1F3B5}",
  notes: "\u{1F3B6}",
  studio_microphone: "\u{1F399}\uFE0F",
  level_slider: "\u{1F39A}\uFE0F",
  control_knobs: "\u{1F39B}\uFE0F",
  microphone: "\u{1F3A4}",
  headphones: "\u{1F3A7}",
  radio: "\u{1F4FB}",
  saxophone: "\u{1F3B7}",
  accordion: "\u{1FA97}",
  guitar: "\u{1F3B8}",
  musical_keyboard: "\u{1F3B9}",
  trumpet: "\u{1F3BA}",
  violin: "\u{1F3BB}",
  banjo: "\u{1FA95}",
  drum: "\u{1F941}",
  long_drum: "\u{1FA98}",
  maracas: "\u{1FA87}",
  flute: "\u{1FA88}",
  iphone: "\u{1F4F1}",
  calling: "\u{1F4F2}",
  phone: "\u260E\uFE0F",
  telephone: "\u260E\uFE0F",
  telephone_receiver: "\u{1F4DE}",
  pager: "\u{1F4DF}",
  fax: "\u{1F4E0}",
  battery: "\u{1F50B}",
  low_battery: "\u{1FAAB}",
  electric_plug: "\u{1F50C}",
  computer: "\u{1F4BB}",
  desktop_computer: "\u{1F5A5}\uFE0F",
  printer: "\u{1F5A8}\uFE0F",
  keyboard: "\u2328\uFE0F",
  computer_mouse: "\u{1F5B1}\uFE0F",
  trackball: "\u{1F5B2}\uFE0F",
  minidisc: "\u{1F4BD}",
  floppy_disk: "\u{1F4BE}",
  cd: "\u{1F4BF}",
  dvd: "\u{1F4C0}",
  abacus: "\u{1F9EE}",
  movie_camera: "\u{1F3A5}",
  film_strip: "\u{1F39E}\uFE0F",
  film_projector: "\u{1F4FD}\uFE0F",
  clapper: "\u{1F3AC}",
  tv: "\u{1F4FA}",
  camera: "\u{1F4F7}",
  camera_flash: "\u{1F4F8}",
  video_camera: "\u{1F4F9}",
  vhs: "\u{1F4FC}",
  mag: "\u{1F50D}",
  mag_right: "\u{1F50E}",
  candle: "\u{1F56F}\uFE0F",
  bulb: "\u{1F4A1}",
  flashlight: "\u{1F526}",
  izakaya_lantern: "\u{1F3EE}",
  lantern: "\u{1F3EE}",
  diya_lamp: "\u{1FA94}",
  notebook_with_decorative_cover: "\u{1F4D4}",
  closed_book: "\u{1F4D5}",
  book: "\u{1F4D6}",
  open_book: "\u{1F4D6}",
  green_book: "\u{1F4D7}",
  blue_book: "\u{1F4D8}",
  orange_book: "\u{1F4D9}",
  books: "\u{1F4DA}",
  notebook: "\u{1F4D3}",
  ledger: "\u{1F4D2}",
  page_with_curl: "\u{1F4C3}",
  scroll: "\u{1F4DC}",
  page_facing_up: "\u{1F4C4}",
  newspaper: "\u{1F4F0}",
  newspaper_roll: "\u{1F5DE}\uFE0F",
  bookmark_tabs: "\u{1F4D1}",
  bookmark: "\u{1F516}",
  label: "\u{1F3F7}\uFE0F",
  moneybag: "\u{1F4B0}",
  coin: "\u{1FA99}",
  yen: "\u{1F4B4}",
  dollar: "\u{1F4B5}",
  euro: "\u{1F4B6}",
  pound: "\u{1F4B7}",
  money_with_wings: "\u{1F4B8}",
  credit_card: "\u{1F4B3}",
  receipt: "\u{1F9FE}",
  chart: "\u{1F4B9}",
  envelope: "\u2709\uFE0F",
  email: "\u{1F4E7}",
  "e-mail": "\u{1F4E7}",
  incoming_envelope: "\u{1F4E8}",
  envelope_with_arrow: "\u{1F4E9}",
  outbox_tray: "\u{1F4E4}",
  inbox_tray: "\u{1F4E5}",
  package: "\u{1F4E6}",
  mailbox: "\u{1F4EB}",
  mailbox_closed: "\u{1F4EA}",
  mailbox_with_mail: "\u{1F4EC}",
  mailbox_with_no_mail: "\u{1F4ED}",
  postbox: "\u{1F4EE}",
  ballot_box: "\u{1F5F3}\uFE0F",
  pencil2: "\u270F\uFE0F",
  black_nib: "\u2712\uFE0F",
  fountain_pen: "\u{1F58B}\uFE0F",
  pen: "\u{1F58A}\uFE0F",
  paintbrush: "\u{1F58C}\uFE0F",
  crayon: "\u{1F58D}\uFE0F",
  memo: "\u{1F4DD}",
  pencil: "\u{1F4DD}",
  briefcase: "\u{1F4BC}",
  file_folder: "\u{1F4C1}",
  open_file_folder: "\u{1F4C2}",
  card_index_dividers: "\u{1F5C2}\uFE0F",
  date: "\u{1F4C5}",
  calendar: "\u{1F4C6}",
  spiral_notepad: "\u{1F5D2}\uFE0F",
  spiral_calendar: "\u{1F5D3}\uFE0F",
  card_index: "\u{1F4C7}",
  chart_with_upwards_trend: "\u{1F4C8}",
  chart_with_downwards_trend: "\u{1F4C9}",
  bar_chart: "\u{1F4CA}",
  clipboard: "\u{1F4CB}",
  pushpin: "\u{1F4CC}",
  round_pushpin: "\u{1F4CD}",
  paperclip: "\u{1F4CE}",
  paperclips: "\u{1F587}\uFE0F",
  straight_ruler: "\u{1F4CF}",
  triangular_ruler: "\u{1F4D0}",
  scissors: "\u2702\uFE0F",
  card_file_box: "\u{1F5C3}\uFE0F",
  file_cabinet: "\u{1F5C4}\uFE0F",
  wastebasket: "\u{1F5D1}\uFE0F",
  lock: "\u{1F512}",
  unlock: "\u{1F513}",
  lock_with_ink_pen: "\u{1F50F}",
  closed_lock_with_key: "\u{1F510}",
  key: "\u{1F511}",
  old_key: "\u{1F5DD}\uFE0F",
  hammer: "\u{1F528}",
  axe: "\u{1FA93}",
  pick: "\u26CF\uFE0F",
  hammer_and_pick: "\u2692\uFE0F",
  hammer_and_wrench: "\u{1F6E0}\uFE0F",
  dagger: "\u{1F5E1}\uFE0F",
  crossed_swords: "\u2694\uFE0F",
  bomb: "\u{1F4A3}",
  boomerang: "\u{1FA83}",
  bow_and_arrow: "\u{1F3F9}",
  shield: "\u{1F6E1}\uFE0F",
  carpentry_saw: "\u{1FA9A}",
  wrench: "\u{1F527}",
  screwdriver: "\u{1FA9B}",
  nut_and_bolt: "\u{1F529}",
  gear: "\u2699\uFE0F",
  clamp: "\u{1F5DC}\uFE0F",
  balance_scale: "\u2696\uFE0F",
  probing_cane: "\u{1F9AF}",
  link: "\u{1F517}",
  chains: "\u26D3\uFE0F",
  hook: "\u{1FA9D}",
  toolbox: "\u{1F9F0}",
  magnet: "\u{1F9F2}",
  ladder: "\u{1FA9C}",
  alembic: "\u2697\uFE0F",
  test_tube: "\u{1F9EA}",
  petri_dish: "\u{1F9EB}",
  dna: "\u{1F9EC}",
  microscope: "\u{1F52C}",
  telescope: "\u{1F52D}",
  satellite: "\u{1F4E1}",
  syringe: "\u{1F489}",
  drop_of_blood: "\u{1FA78}",
  pill: "\u{1F48A}",
  adhesive_bandage: "\u{1FA79}",
  crutch: "\u{1FA7C}",
  stethoscope: "\u{1FA7A}",
  x_ray: "\u{1FA7B}",
  door: "\u{1F6AA}",
  elevator: "\u{1F6D7}",
  mirror: "\u{1FA9E}",
  window: "\u{1FA9F}",
  bed: "\u{1F6CF}\uFE0F",
  couch_and_lamp: "\u{1F6CB}\uFE0F",
  chair: "\u{1FA91}",
  toilet: "\u{1F6BD}",
  plunger: "\u{1FAA0}",
  shower: "\u{1F6BF}",
  bathtub: "\u{1F6C1}",
  mouse_trap: "\u{1FAA4}",
  razor: "\u{1FA92}",
  lotion_bottle: "\u{1F9F4}",
  safety_pin: "\u{1F9F7}",
  broom: "\u{1F9F9}",
  basket: "\u{1F9FA}",
  roll_of_paper: "\u{1F9FB}",
  bucket: "\u{1FAA3}",
  soap: "\u{1F9FC}",
  bubbles: "\u{1FAE7}",
  toothbrush: "\u{1FAA5}",
  sponge: "\u{1F9FD}",
  fire_extinguisher: "\u{1F9EF}",
  shopping_cart: "\u{1F6D2}",
  smoking: "\u{1F6AC}",
  coffin: "\u26B0\uFE0F",
  headstone: "\u{1FAA6}",
  funeral_urn: "\u26B1\uFE0F",
  nazar_amulet: "\u{1F9FF}",
  hamsa: "\u{1FAAC}",
  moyai: "\u{1F5FF}",
  placard: "\u{1FAA7}",
  identification_card: "\u{1FAAA}",
  atm: "\u{1F3E7}",
  put_litter_in_its_place: "\u{1F6AE}",
  potable_water: "\u{1F6B0}",
  wheelchair: "\u267F",
  mens: "\u{1F6B9}",
  womens: "\u{1F6BA}",
  restroom: "\u{1F6BB}",
  baby_symbol: "\u{1F6BC}",
  wc: "\u{1F6BE}",
  passport_control: "\u{1F6C2}",
  customs: "\u{1F6C3}",
  baggage_claim: "\u{1F6C4}",
  left_luggage: "\u{1F6C5}",
  warning: "\u26A0\uFE0F",
  children_crossing: "\u{1F6B8}",
  no_entry: "\u26D4",
  no_entry_sign: "\u{1F6AB}",
  no_bicycles: "\u{1F6B3}",
  no_smoking: "\u{1F6AD}",
  do_not_litter: "\u{1F6AF}",
  "non-potable_water": "\u{1F6B1}",
  no_pedestrians: "\u{1F6B7}",
  no_mobile_phones: "\u{1F4F5}",
  underage: "\u{1F51E}",
  radioactive: "\u2622\uFE0F",
  biohazard: "\u2623\uFE0F",
  arrow_up: "\u2B06\uFE0F",
  arrow_upper_right: "\u2197\uFE0F",
  arrow_right: "\u27A1\uFE0F",
  arrow_lower_right: "\u2198\uFE0F",
  arrow_down: "\u2B07\uFE0F",
  arrow_lower_left: "\u2199\uFE0F",
  arrow_left: "\u2B05\uFE0F",
  arrow_upper_left: "\u2196\uFE0F",
  arrow_up_down: "\u2195\uFE0F",
  left_right_arrow: "\u2194\uFE0F",
  leftwards_arrow_with_hook: "\u21A9\uFE0F",
  arrow_right_hook: "\u21AA\uFE0F",
  arrow_heading_up: "\u2934\uFE0F",
  arrow_heading_down: "\u2935\uFE0F",
  arrows_clockwise: "\u{1F503}",
  arrows_counterclockwise: "\u{1F504}",
  back: "\u{1F519}",
  end: "\u{1F51A}",
  on: "\u{1F51B}",
  soon: "\u{1F51C}",
  top: "\u{1F51D}",
  place_of_worship: "\u{1F6D0}",
  atom_symbol: "\u269B\uFE0F",
  om: "\u{1F549}\uFE0F",
  star_of_david: "\u2721\uFE0F",
  wheel_of_dharma: "\u2638\uFE0F",
  yin_yang: "\u262F\uFE0F",
  latin_cross: "\u271D\uFE0F",
  orthodox_cross: "\u2626\uFE0F",
  star_and_crescent: "\u262A\uFE0F",
  peace_symbol: "\u262E\uFE0F",
  menorah: "\u{1F54E}",
  six_pointed_star: "\u{1F52F}",
  khanda: "\u{1FAAF}",
  aries: "\u2648",
  taurus: "\u2649",
  gemini: "\u264A",
  cancer: "\u264B",
  leo: "\u264C",
  virgo: "\u264D",
  libra: "\u264E",
  scorpius: "\u264F",
  sagittarius: "\u2650",
  capricorn: "\u2651",
  aquarius: "\u2652",
  pisces: "\u2653",
  ophiuchus: "\u26CE",
  twisted_rightwards_arrows: "\u{1F500}",
  repeat: "\u{1F501}",
  repeat_one: "\u{1F502}",
  arrow_forward: "\u25B6\uFE0F",
  fast_forward: "\u23E9",
  next_track_button: "\u23ED\uFE0F",
  play_or_pause_button: "\u23EF\uFE0F",
  arrow_backward: "\u25C0\uFE0F",
  rewind: "\u23EA",
  previous_track_button: "\u23EE\uFE0F",
  arrow_up_small: "\u{1F53C}",
  arrow_double_up: "\u23EB",
  arrow_down_small: "\u{1F53D}",
  arrow_double_down: "\u23EC",
  pause_button: "\u23F8\uFE0F",
  stop_button: "\u23F9\uFE0F",
  record_button: "\u23FA\uFE0F",
  eject_button: "\u23CF\uFE0F",
  cinema: "\u{1F3A6}",
  low_brightness: "\u{1F505}",
  high_brightness: "\u{1F506}",
  signal_strength: "\u{1F4F6}",
  wireless: "\u{1F6DC}",
  vibration_mode: "\u{1F4F3}",
  mobile_phone_off: "\u{1F4F4}",
  female_sign: "\u2640\uFE0F",
  male_sign: "\u2642\uFE0F",
  transgender_symbol: "\u26A7\uFE0F",
  heavy_multiplication_x: "\u2716\uFE0F",
  heavy_plus_sign: "\u2795",
  heavy_minus_sign: "\u2796",
  heavy_division_sign: "\u2797",
  heavy_equals_sign: "\u{1F7F0}",
  infinity: "\u267E\uFE0F",
  bangbang: "\u203C\uFE0F",
  interrobang: "\u2049\uFE0F",
  question: "\u2753",
  grey_question: "\u2754",
  grey_exclamation: "\u2755",
  exclamation: "\u2757",
  heavy_exclamation_mark: "\u2757",
  wavy_dash: "\u3030\uFE0F",
  currency_exchange: "\u{1F4B1}",
  heavy_dollar_sign: "\u{1F4B2}",
  medical_symbol: "\u2695\uFE0F",
  recycle: "\u267B\uFE0F",
  fleur_de_lis: "\u269C\uFE0F",
  trident: "\u{1F531}",
  name_badge: "\u{1F4DB}",
  beginner: "\u{1F530}",
  o: "\u2B55",
  white_check_mark: "\u2705",
  ballot_box_with_check: "\u2611\uFE0F",
  heavy_check_mark: "\u2714\uFE0F",
  x: "\u274C",
  negative_squared_cross_mark: "\u274E",
  curly_loop: "\u27B0",
  loop: "\u27BF",
  part_alternation_mark: "\u303D\uFE0F",
  eight_spoked_asterisk: "\u2733\uFE0F",
  eight_pointed_black_star: "\u2734\uFE0F",
  sparkle: "\u2747\uFE0F",
  copyright: "\xA9\uFE0F",
  registered: "\xAE\uFE0F",
  tm: "\u2122\uFE0F",
  hash: "#\uFE0F\u20E3",
  asterisk: "*\uFE0F\u20E3",
  zero: "0\uFE0F\u20E3",
  one: "1\uFE0F\u20E3",
  two: "2\uFE0F\u20E3",
  three: "3\uFE0F\u20E3",
  four: "4\uFE0F\u20E3",
  five: "5\uFE0F\u20E3",
  six: "6\uFE0F\u20E3",
  seven: "7\uFE0F\u20E3",
  eight: "8\uFE0F\u20E3",
  nine: "9\uFE0F\u20E3",
  keycap_ten: "\u{1F51F}",
  capital_abcd: "\u{1F520}",
  abcd: "\u{1F521}",
  symbols: "\u{1F523}",
  abc: "\u{1F524}",
  a: "\u{1F170}\uFE0F",
  ab: "\u{1F18E}",
  b: "\u{1F171}\uFE0F",
  cl: "\u{1F191}",
  cool: "\u{1F192}",
  free: "\u{1F193}",
  information_source: "\u2139\uFE0F",
  id: "\u{1F194}",
  m: "\u24C2\uFE0F",
  new: "\u{1F195}",
  ng: "\u{1F196}",
  o2: "\u{1F17E}\uFE0F",
  ok: "\u{1F197}",
  parking: "\u{1F17F}\uFE0F",
  sos: "\u{1F198}",
  up: "\u{1F199}",
  vs: "\u{1F19A}",
  koko: "\u{1F201}",
  sa: "\u{1F202}\uFE0F",
  u6708: "\u{1F237}\uFE0F",
  u6709: "\u{1F236}",
  u6307: "\u{1F22F}",
  ideograph_advantage: "\u{1F250}",
  u5272: "\u{1F239}",
  u7121: "\u{1F21A}",
  u7981: "\u{1F232}",
  accept: "\u{1F251}",
  u7533: "\u{1F238}",
  u5408: "\u{1F234}",
  u7a7a: "\u{1F233}",
  congratulations: "\u3297\uFE0F",
  secret: "\u3299\uFE0F",
  u55b6: "\u{1F23A}",
  u6e80: "\u{1F235}",
  red_circle: "\u{1F534}",
  orange_circle: "\u{1F7E0}",
  yellow_circle: "\u{1F7E1}",
  green_circle: "\u{1F7E2}",
  large_blue_circle: "\u{1F535}",
  purple_circle: "\u{1F7E3}",
  brown_circle: "\u{1F7E4}",
  black_circle: "\u26AB",
  white_circle: "\u26AA",
  red_square: "\u{1F7E5}",
  orange_square: "\u{1F7E7}",
  yellow_square: "\u{1F7E8}",
  green_square: "\u{1F7E9}",
  blue_square: "\u{1F7E6}",
  purple_square: "\u{1F7EA}",
  brown_square: "\u{1F7EB}",
  black_large_square: "\u2B1B",
  white_large_square: "\u2B1C",
  black_medium_square: "\u25FC\uFE0F",
  white_medium_square: "\u25FB\uFE0F",
  black_medium_small_square: "\u25FE",
  white_medium_small_square: "\u25FD",
  black_small_square: "\u25AA\uFE0F",
  white_small_square: "\u25AB\uFE0F",
  large_orange_diamond: "\u{1F536}",
  large_blue_diamond: "\u{1F537}",
  small_orange_diamond: "\u{1F538}",
  small_blue_diamond: "\u{1F539}",
  small_red_triangle: "\u{1F53A}",
  small_red_triangle_down: "\u{1F53B}",
  diamond_shape_with_a_dot_inside: "\u{1F4A0}",
  radio_button: "\u{1F518}",
  white_square_button: "\u{1F533}",
  black_square_button: "\u{1F532}",
  checkered_flag: "\u{1F3C1}",
  triangular_flag_on_post: "\u{1F6A9}",
  crossed_flags: "\u{1F38C}",
  black_flag: "\u{1F3F4}",
  white_flag: "\u{1F3F3}\uFE0F",
  rainbow_flag: "\u{1F3F3}\uFE0F\u200D\u{1F308}",
  transgender_flag: "\u{1F3F3}\uFE0F\u200D\u26A7\uFE0F",
  pirate_flag: "\u{1F3F4}\u200D\u2620\uFE0F",
  ascension_island: "\u{1F1E6}\u{1F1E8}",
  andorra: "\u{1F1E6}\u{1F1E9}",
  united_arab_emirates: "\u{1F1E6}\u{1F1EA}",
  afghanistan: "\u{1F1E6}\u{1F1EB}",
  antigua_barbuda: "\u{1F1E6}\u{1F1EC}",
  anguilla: "\u{1F1E6}\u{1F1EE}",
  albania: "\u{1F1E6}\u{1F1F1}",
  armenia: "\u{1F1E6}\u{1F1F2}",
  angola: "\u{1F1E6}\u{1F1F4}",
  antarctica: "\u{1F1E6}\u{1F1F6}",
  argentina: "\u{1F1E6}\u{1F1F7}",
  american_samoa: "\u{1F1E6}\u{1F1F8}",
  austria: "\u{1F1E6}\u{1F1F9}",
  australia: "\u{1F1E6}\u{1F1FA}",
  aruba: "\u{1F1E6}\u{1F1FC}",
  aland_islands: "\u{1F1E6}\u{1F1FD}",
  azerbaijan: "\u{1F1E6}\u{1F1FF}",
  bosnia_herzegovina: "\u{1F1E7}\u{1F1E6}",
  barbados: "\u{1F1E7}\u{1F1E7}",
  bangladesh: "\u{1F1E7}\u{1F1E9}",
  belgium: "\u{1F1E7}\u{1F1EA}",
  burkina_faso: "\u{1F1E7}\u{1F1EB}",
  bulgaria: "\u{1F1E7}\u{1F1EC}",
  bahrain: "\u{1F1E7}\u{1F1ED}",
  burundi: "\u{1F1E7}\u{1F1EE}",
  benin: "\u{1F1E7}\u{1F1EF}",
  st_barthelemy: "\u{1F1E7}\u{1F1F1}",
  bermuda: "\u{1F1E7}\u{1F1F2}",
  brunei: "\u{1F1E7}\u{1F1F3}",
  bolivia: "\u{1F1E7}\u{1F1F4}",
  caribbean_netherlands: "\u{1F1E7}\u{1F1F6}",
  brazil: "\u{1F1E7}\u{1F1F7}",
  bahamas: "\u{1F1E7}\u{1F1F8}",
  bhutan: "\u{1F1E7}\u{1F1F9}",
  bouvet_island: "\u{1F1E7}\u{1F1FB}",
  botswana: "\u{1F1E7}\u{1F1FC}",
  belarus: "\u{1F1E7}\u{1F1FE}",
  belize: "\u{1F1E7}\u{1F1FF}",
  canada: "\u{1F1E8}\u{1F1E6}",
  cocos_islands: "\u{1F1E8}\u{1F1E8}",
  congo_kinshasa: "\u{1F1E8}\u{1F1E9}",
  central_african_republic: "\u{1F1E8}\u{1F1EB}",
  congo_brazzaville: "\u{1F1E8}\u{1F1EC}",
  switzerland: "\u{1F1E8}\u{1F1ED}",
  cote_divoire: "\u{1F1E8}\u{1F1EE}",
  cook_islands: "\u{1F1E8}\u{1F1F0}",
  chile: "\u{1F1E8}\u{1F1F1}",
  cameroon: "\u{1F1E8}\u{1F1F2}",
  cn: "\u{1F1E8}\u{1F1F3}",
  colombia: "\u{1F1E8}\u{1F1F4}",
  clipperton_island: "\u{1F1E8}\u{1F1F5}",
  costa_rica: "\u{1F1E8}\u{1F1F7}",
  cuba: "\u{1F1E8}\u{1F1FA}",
  cape_verde: "\u{1F1E8}\u{1F1FB}",
  curacao: "\u{1F1E8}\u{1F1FC}",
  christmas_island: "\u{1F1E8}\u{1F1FD}",
  cyprus: "\u{1F1E8}\u{1F1FE}",
  czech_republic: "\u{1F1E8}\u{1F1FF}",
  de: "\u{1F1E9}\u{1F1EA}",
  diego_garcia: "\u{1F1E9}\u{1F1EC}",
  djibouti: "\u{1F1E9}\u{1F1EF}",
  denmark: "\u{1F1E9}\u{1F1F0}",
  dominica: "\u{1F1E9}\u{1F1F2}",
  dominican_republic: "\u{1F1E9}\u{1F1F4}",
  algeria: "\u{1F1E9}\u{1F1FF}",
  ceuta_melilla: "\u{1F1EA}\u{1F1E6}",
  ecuador: "\u{1F1EA}\u{1F1E8}",
  estonia: "\u{1F1EA}\u{1F1EA}",
  egypt: "\u{1F1EA}\u{1F1EC}",
  western_sahara: "\u{1F1EA}\u{1F1ED}",
  eritrea: "\u{1F1EA}\u{1F1F7}",
  es: "\u{1F1EA}\u{1F1F8}",
  ethiopia: "\u{1F1EA}\u{1F1F9}",
  eu: "\u{1F1EA}\u{1F1FA}",
  european_union: "\u{1F1EA}\u{1F1FA}",
  finland: "\u{1F1EB}\u{1F1EE}",
  fiji: "\u{1F1EB}\u{1F1EF}",
  falkland_islands: "\u{1F1EB}\u{1F1F0}",
  micronesia: "\u{1F1EB}\u{1F1F2}",
  faroe_islands: "\u{1F1EB}\u{1F1F4}",
  fr: "\u{1F1EB}\u{1F1F7}",
  gabon: "\u{1F1EC}\u{1F1E6}",
  gb: "\u{1F1EC}\u{1F1E7}",
  uk: "\u{1F1EC}\u{1F1E7}",
  grenada: "\u{1F1EC}\u{1F1E9}",
  georgia: "\u{1F1EC}\u{1F1EA}",
  french_guiana: "\u{1F1EC}\u{1F1EB}",
  guernsey: "\u{1F1EC}\u{1F1EC}",
  ghana: "\u{1F1EC}\u{1F1ED}",
  gibraltar: "\u{1F1EC}\u{1F1EE}",
  greenland: "\u{1F1EC}\u{1F1F1}",
  gambia: "\u{1F1EC}\u{1F1F2}",
  guinea: "\u{1F1EC}\u{1F1F3}",
  guadeloupe: "\u{1F1EC}\u{1F1F5}",
  equatorial_guinea: "\u{1F1EC}\u{1F1F6}",
  greece: "\u{1F1EC}\u{1F1F7}",
  south_georgia_south_sandwich_islands: "\u{1F1EC}\u{1F1F8}",
  guatemala: "\u{1F1EC}\u{1F1F9}",
  guam: "\u{1F1EC}\u{1F1FA}",
  guinea_bissau: "\u{1F1EC}\u{1F1FC}",
  guyana: "\u{1F1EC}\u{1F1FE}",
  hong_kong: "\u{1F1ED}\u{1F1F0}",
  heard_mcdonald_islands: "\u{1F1ED}\u{1F1F2}",
  honduras: "\u{1F1ED}\u{1F1F3}",
  croatia: "\u{1F1ED}\u{1F1F7}",
  haiti: "\u{1F1ED}\u{1F1F9}",
  hungary: "\u{1F1ED}\u{1F1FA}",
  canary_islands: "\u{1F1EE}\u{1F1E8}",
  indonesia: "\u{1F1EE}\u{1F1E9}",
  ireland: "\u{1F1EE}\u{1F1EA}",
  israel: "\u{1F1EE}\u{1F1F1}",
  isle_of_man: "\u{1F1EE}\u{1F1F2}",
  india: "\u{1F1EE}\u{1F1F3}",
  british_indian_ocean_territory: "\u{1F1EE}\u{1F1F4}",
  iraq: "\u{1F1EE}\u{1F1F6}",
  iran: "\u{1F1EE}\u{1F1F7}",
  iceland: "\u{1F1EE}\u{1F1F8}",
  it: "\u{1F1EE}\u{1F1F9}",
  jersey: "\u{1F1EF}\u{1F1EA}",
  jamaica: "\u{1F1EF}\u{1F1F2}",
  jordan: "\u{1F1EF}\u{1F1F4}",
  jp: "\u{1F1EF}\u{1F1F5}",
  kenya: "\u{1F1F0}\u{1F1EA}",
  kyrgyzstan: "\u{1F1F0}\u{1F1EC}",
  cambodia: "\u{1F1F0}\u{1F1ED}",
  kiribati: "\u{1F1F0}\u{1F1EE}",
  comoros: "\u{1F1F0}\u{1F1F2}",
  st_kitts_nevis: "\u{1F1F0}\u{1F1F3}",
  north_korea: "\u{1F1F0}\u{1F1F5}",
  kr: "\u{1F1F0}\u{1F1F7}",
  kuwait: "\u{1F1F0}\u{1F1FC}",
  cayman_islands: "\u{1F1F0}\u{1F1FE}",
  kazakhstan: "\u{1F1F0}\u{1F1FF}",
  laos: "\u{1F1F1}\u{1F1E6}",
  lebanon: "\u{1F1F1}\u{1F1E7}",
  st_lucia: "\u{1F1F1}\u{1F1E8}",
  liechtenstein: "\u{1F1F1}\u{1F1EE}",
  sri_lanka: "\u{1F1F1}\u{1F1F0}",
  liberia: "\u{1F1F1}\u{1F1F7}",
  lesotho: "\u{1F1F1}\u{1F1F8}",
  lithuania: "\u{1F1F1}\u{1F1F9}",
  luxembourg: "\u{1F1F1}\u{1F1FA}",
  latvia: "\u{1F1F1}\u{1F1FB}",
  libya: "\u{1F1F1}\u{1F1FE}",
  morocco: "\u{1F1F2}\u{1F1E6}",
  monaco: "\u{1F1F2}\u{1F1E8}",
  moldova: "\u{1F1F2}\u{1F1E9}",
  montenegro: "\u{1F1F2}\u{1F1EA}",
  st_martin: "\u{1F1F2}\u{1F1EB}",
  madagascar: "\u{1F1F2}\u{1F1EC}",
  marshall_islands: "\u{1F1F2}\u{1F1ED}",
  macedonia: "\u{1F1F2}\u{1F1F0}",
  mali: "\u{1F1F2}\u{1F1F1}",
  myanmar: "\u{1F1F2}\u{1F1F2}",
  mongolia: "\u{1F1F2}\u{1F1F3}",
  macau: "\u{1F1F2}\u{1F1F4}",
  northern_mariana_islands: "\u{1F1F2}\u{1F1F5}",
  martinique: "\u{1F1F2}\u{1F1F6}",
  mauritania: "\u{1F1F2}\u{1F1F7}",
  montserrat: "\u{1F1F2}\u{1F1F8}",
  malta: "\u{1F1F2}\u{1F1F9}",
  mauritius: "\u{1F1F2}\u{1F1FA}",
  maldives: "\u{1F1F2}\u{1F1FB}",
  malawi: "\u{1F1F2}\u{1F1FC}",
  mexico: "\u{1F1F2}\u{1F1FD}",
  malaysia: "\u{1F1F2}\u{1F1FE}",
  mozambique: "\u{1F1F2}\u{1F1FF}",
  namibia: "\u{1F1F3}\u{1F1E6}",
  new_caledonia: "\u{1F1F3}\u{1F1E8}",
  niger: "\u{1F1F3}\u{1F1EA}",
  norfolk_island: "\u{1F1F3}\u{1F1EB}",
  nigeria: "\u{1F1F3}\u{1F1EC}",
  nicaragua: "\u{1F1F3}\u{1F1EE}",
  netherlands: "\u{1F1F3}\u{1F1F1}",
  norway: "\u{1F1F3}\u{1F1F4}",
  nepal: "\u{1F1F3}\u{1F1F5}",
  nauru: "\u{1F1F3}\u{1F1F7}",
  niue: "\u{1F1F3}\u{1F1FA}",
  new_zealand: "\u{1F1F3}\u{1F1FF}",
  oman: "\u{1F1F4}\u{1F1F2}",
  panama: "\u{1F1F5}\u{1F1E6}",
  peru: "\u{1F1F5}\u{1F1EA}",
  french_polynesia: "\u{1F1F5}\u{1F1EB}",
  papua_new_guinea: "\u{1F1F5}\u{1F1EC}",
  philippines: "\u{1F1F5}\u{1F1ED}",
  pakistan: "\u{1F1F5}\u{1F1F0}",
  poland: "\u{1F1F5}\u{1F1F1}",
  st_pierre_miquelon: "\u{1F1F5}\u{1F1F2}",
  pitcairn_islands: "\u{1F1F5}\u{1F1F3}",
  puerto_rico: "\u{1F1F5}\u{1F1F7}",
  palestinian_territories: "\u{1F1F5}\u{1F1F8}",
  portugal: "\u{1F1F5}\u{1F1F9}",
  palau: "\u{1F1F5}\u{1F1FC}",
  paraguay: "\u{1F1F5}\u{1F1FE}",
  qatar: "\u{1F1F6}\u{1F1E6}",
  reunion: "\u{1F1F7}\u{1F1EA}",
  romania: "\u{1F1F7}\u{1F1F4}",
  serbia: "\u{1F1F7}\u{1F1F8}",
  ru: "\u{1F1F7}\u{1F1FA}",
  rwanda: "\u{1F1F7}\u{1F1FC}",
  saudi_arabia: "\u{1F1F8}\u{1F1E6}",
  solomon_islands: "\u{1F1F8}\u{1F1E7}",
  seychelles: "\u{1F1F8}\u{1F1E8}",
  sudan: "\u{1F1F8}\u{1F1E9}",
  sweden: "\u{1F1F8}\u{1F1EA}",
  singapore: "\u{1F1F8}\u{1F1EC}",
  st_helena: "\u{1F1F8}\u{1F1ED}",
  slovenia: "\u{1F1F8}\u{1F1EE}",
  svalbard_jan_mayen: "\u{1F1F8}\u{1F1EF}",
  slovakia: "\u{1F1F8}\u{1F1F0}",
  sierra_leone: "\u{1F1F8}\u{1F1F1}",
  san_marino: "\u{1F1F8}\u{1F1F2}",
  senegal: "\u{1F1F8}\u{1F1F3}",
  somalia: "\u{1F1F8}\u{1F1F4}",
  suriname: "\u{1F1F8}\u{1F1F7}",
  south_sudan: "\u{1F1F8}\u{1F1F8}",
  sao_tome_principe: "\u{1F1F8}\u{1F1F9}",
  el_salvador: "\u{1F1F8}\u{1F1FB}",
  sint_maarten: "\u{1F1F8}\u{1F1FD}",
  syria: "\u{1F1F8}\u{1F1FE}",
  swaziland: "\u{1F1F8}\u{1F1FF}",
  tristan_da_cunha: "\u{1F1F9}\u{1F1E6}",
  turks_caicos_islands: "\u{1F1F9}\u{1F1E8}",
  chad: "\u{1F1F9}\u{1F1E9}",
  french_southern_territories: "\u{1F1F9}\u{1F1EB}",
  togo: "\u{1F1F9}\u{1F1EC}",
  thailand: "\u{1F1F9}\u{1F1ED}",
  tajikistan: "\u{1F1F9}\u{1F1EF}",
  tokelau: "\u{1F1F9}\u{1F1F0}",
  timor_leste: "\u{1F1F9}\u{1F1F1}",
  turkmenistan: "\u{1F1F9}\u{1F1F2}",
  tunisia: "\u{1F1F9}\u{1F1F3}",
  tonga: "\u{1F1F9}\u{1F1F4}",
  tr: "\u{1F1F9}\u{1F1F7}",
  trinidad_tobago: "\u{1F1F9}\u{1F1F9}",
  tuvalu: "\u{1F1F9}\u{1F1FB}",
  taiwan: "\u{1F1F9}\u{1F1FC}",
  tanzania: "\u{1F1F9}\u{1F1FF}",
  ukraine: "\u{1F1FA}\u{1F1E6}",
  uganda: "\u{1F1FA}\u{1F1EC}",
  us_outlying_islands: "\u{1F1FA}\u{1F1F2}",
  united_nations: "\u{1F1FA}\u{1F1F3}",
  us: "\u{1F1FA}\u{1F1F8}",
  uruguay: "\u{1F1FA}\u{1F1FE}",
  uzbekistan: "\u{1F1FA}\u{1F1FF}",
  vatican_city: "\u{1F1FB}\u{1F1E6}",
  st_vincent_grenadines: "\u{1F1FB}\u{1F1E8}",
  venezuela: "\u{1F1FB}\u{1F1EA}",
  british_virgin_islands: "\u{1F1FB}\u{1F1EC}",
  us_virgin_islands: "\u{1F1FB}\u{1F1EE}",
  vietnam: "\u{1F1FB}\u{1F1F3}",
  vanuatu: "\u{1F1FB}\u{1F1FA}",
  wallis_futuna: "\u{1F1FC}\u{1F1EB}",
  samoa: "\u{1F1FC}\u{1F1F8}",
  kosovo: "\u{1F1FD}\u{1F1F0}",
  yemen: "\u{1F1FE}\u{1F1EA}",
  mayotte: "\u{1F1FE}\u{1F1F9}",
  south_africa: "\u{1F1FF}\u{1F1E6}",
  zambia: "\u{1F1FF}\u{1F1F2}",
  zimbabwe: "\u{1F1FF}\u{1F1FC}",
  england: "\u{1F3F4}\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F}",
  scotland: "\u{1F3F4}\u{E0067}\u{E0062}\u{E0073}\u{E0063}\u{E0074}\u{E007F}",
  wales: "\u{1F3F4}\u{E0067}\u{E0062}\u{E0077}\u{E006C}\u{E0073}\u{E007F}"
};

// src/format/rules.ts
var LINT_RULES = {
  footnote: "Footnotes are dropped.",
  subscript: "Tilde subscript is dropped.",
  "table-escaped-pipe": "An escaped pipe in a plain table cell splits the row.",
  "image-in-link": "The link around an image is dropped.",
  "content-too-long": "Documents over 250,000 characters are rejected.",
  "duplicate-title": "Two files map to one document title.",
  "table-alignment": "Table column alignment is dropped.",
  "link-title": "A link title is dropped.",
  "image-title": "An image title is dropped from the Markdown.",
  "code-in-emphasis": "Bold or italic around inline code is dropped from the code.",
  "hard-break-backslash": "A backslash line break becomes a plain line break.",
  "git-conflict-marker": "Git conflict marker lines are rewritten as headings, quotes or collapsible sections.",
  "url-in-html": "A URL inside raw HTML is turned into a Markdown link.",
  "block-first-in-list-item": "A list item that starts with a heading, code or quote is written in a form Markdown reads as an empty item."
};
var CONTENT_LIMIT = 25e4;

// src/format/markdown.ts
import { isDeepStrictEqual } from "node:util";

// node_modules/mdast-util-to-string/lib/index.js
var emptyOptions = {};
function toString(value, options) {
  const settings = options || emptyOptions;
  const includeImageAlt = typeof settings.includeImageAlt === "boolean" ? settings.includeImageAlt : true;
  const includeHtml = typeof settings.includeHtml === "boolean" ? settings.includeHtml : true;
  return one(value, includeImageAlt, includeHtml);
}
function one(value, includeImageAlt, includeHtml) {
  if (node(value)) {
    if ("value" in value) {
      return value.type === "html" && !includeHtml ? "" : value.value;
    }
    if (includeImageAlt && "alt" in value && value.alt) {
      return value.alt;
    }
    if ("children" in value) {
      return all(value.children, includeImageAlt, includeHtml);
    }
  }
  if (Array.isArray(value)) {
    return all(value, includeImageAlt, includeHtml);
  }
  return "";
}
function all(values, includeImageAlt, includeHtml) {
  const result = [];
  let index2 = -1;
  while (++index2 < values.length) {
    result[index2] = one(values[index2], includeImageAlt, includeHtml);
  }
  return result.join("");
}
function node(value) {
  return Boolean(value && typeof value === "object");
}

// node_modules/micromark-util-chunked/index.js
function splice(list2, start2, remove, items) {
  const end2 = list2.length;
  let chunkStart = 0;
  let parameters;
  if (start2 < 0) {
    start2 = -start2 > end2 ? 0 : end2 + start2;
  } else {
    start2 = start2 > end2 ? end2 : start2;
  }
  remove = remove > 0 ? remove : 0;
  if (items.length < 1e4) {
    parameters = Array.from(items);
    parameters.unshift(start2, remove);
    list2.splice(...parameters);
  } else {
    if (remove) list2.splice(start2, remove);
    while (chunkStart < items.length) {
      parameters = items.slice(chunkStart, chunkStart + 1e4);
      parameters.unshift(start2, 0);
      list2.splice(...parameters);
      chunkStart += 1e4;
      start2 += 1e4;
    }
  }
}
function push(list2, items) {
  if (list2.length > 0) {
    splice(list2, list2.length, 0, items);
    return list2;
  }
  return items;
}

// node_modules/micromark-util-combine-extensions/index.js
var hasOwnProperty = {}.hasOwnProperty;
function combineExtensions(extensions) {
  const all2 = {};
  let index2 = -1;
  while (++index2 < extensions.length) {
    syntaxExtension(all2, extensions[index2]);
  }
  return all2;
}
function syntaxExtension(all2, extension2) {
  let hook;
  for (hook in extension2) {
    const maybe = hasOwnProperty.call(all2, hook) ? all2[hook] : void 0;
    const left = maybe || (all2[hook] = {});
    const right = extension2[hook];
    let code2;
    if (right) {
      for (code2 in right) {
        if (!hasOwnProperty.call(left, code2)) left[code2] = [];
        const value = right[code2];
        constructs(
          // @ts-expect-error Looks like a list.
          left[code2],
          Array.isArray(value) ? value : value ? [value] : []
        );
      }
    }
  }
}
function constructs(existing, list2) {
  let index2 = -1;
  const before = [];
  while (++index2 < list2.length) {
    ;
    (list2[index2].add === "after" ? existing : before).push(list2[index2]);
  }
  splice(existing, 0, 0, before);
}

// node_modules/micromark-util-decode-numeric-character-reference/index.js
function decodeNumericCharacterReference(value, base) {
  const code2 = Number.parseInt(value, base);
  if (
    // C0 except for HT, LF, FF, CR, space.
    code2 < 9 || code2 === 11 || code2 > 13 && code2 < 32 || // Control character (DEL) of C0, and C1 controls.
    code2 > 126 && code2 < 160 || // Lone high surrogates and low surrogates.
    code2 > 55295 && code2 < 57344 || // Noncharacters.
    code2 > 64975 && code2 < 65008 || /* eslint-disable no-bitwise */
    (code2 & 65535) === 65535 || (code2 & 65535) === 65534 || /* eslint-enable no-bitwise */
    // Out of range
    code2 > 1114111
  ) {
    return "\uFFFD";
  }
  return String.fromCodePoint(code2);
}

// node_modules/micromark-util-normalize-identifier/index.js
function normalizeIdentifier(value) {
  return value.replace(/[\t\n\r ]+/g, " ").replace(/^ | $/g, "").toLowerCase().toUpperCase();
}

// node_modules/micromark-util-character/index.js
var asciiAlpha = regexCheck(/[A-Za-z]/);
var asciiAlphanumeric = regexCheck(/[\dA-Za-z]/);
var asciiAtext = regexCheck(/[#-'*+\--9=?A-Z^-~]/);
function asciiControl(code2) {
  return (
    // Special whitespace codes (which have negative values), C0 and Control
    // character DEL
    code2 !== null && (code2 < 32 || code2 === 127)
  );
}
var asciiDigit = regexCheck(/\d/);
var asciiHexDigit = regexCheck(/[\dA-Fa-f]/);
var asciiPunctuation = regexCheck(/[!-/:-@[-`{-~]/);
function markdownLineEnding(code2) {
  return code2 !== null && code2 < -2;
}
function markdownLineEndingOrSpace(code2) {
  return code2 !== null && (code2 < 0 || code2 === 32);
}
function markdownSpace(code2) {
  return code2 === -2 || code2 === -1 || code2 === 32;
}
var unicodePunctuation = regexCheck(new RegExp("\\p{P}|\\p{S}", "u"));
var unicodeWhitespace = regexCheck(/\s/);
function regexCheck(regex) {
  return check;
  function check(code2) {
    return code2 !== null && code2 > -1 && regex.test(String.fromCharCode(code2));
  }
}

// node_modules/micromark-util-sanitize-uri/index.js
function normalizeUri(value) {
  const result = [];
  let index2 = -1;
  let start2 = 0;
  let skip = 0;
  while (++index2 < value.length) {
    const code2 = value.charCodeAt(index2);
    let replace2 = "";
    if (code2 === 37 && asciiAlphanumeric(value.charCodeAt(index2 + 1)) && asciiAlphanumeric(value.charCodeAt(index2 + 2))) {
      skip = 2;
    } else if (code2 < 128) {
      if (!/[!#$&-;=?-Z_a-z~]/.test(String.fromCharCode(code2))) {
        replace2 = String.fromCharCode(code2);
      }
    } else if (code2 > 55295 && code2 < 57344) {
      const next = value.charCodeAt(index2 + 1);
      if (code2 < 56320 && next > 56319 && next < 57344) {
        replace2 = String.fromCharCode(code2, next);
        skip = 1;
      } else {
        replace2 = "\uFFFD";
      }
    } else {
      replace2 = String.fromCharCode(code2);
    }
    if (replace2) {
      result.push(value.slice(start2, index2), encodeURIComponent(replace2));
      start2 = index2 + skip + 1;
      replace2 = "";
    }
    if (skip) {
      index2 += skip;
      skip = 0;
    }
  }
  return result.join("") + value.slice(start2);
}

// node_modules/micromark-factory-space/index.js
function factorySpace(effects, ok3, type, max) {
  const limit = max ? max - 1 : Infinity;
  let size = 0;
  return start2;
  function start2(code2) {
    if (markdownSpace(code2)) {
      effects.enter(type);
      return prefix(code2);
    }
    return ok3(code2);
  }
  function prefix(code2) {
    if (markdownSpace(code2) && size++ < limit) {
      effects.consume(code2);
      return prefix;
    }
    effects.exit(type);
    return ok3(code2);
  }
}
function factorySpaceMinMax(effects, ok3, nok, type, min, max) {
  let size = 0;
  return start2;
  function start2(code2) {
    if (max > 0 && markdownSpace(code2)) {
      effects.enter(type);
      return prefix(code2);
    }
    return after(code2);
  }
  function prefix(code2) {
    if (markdownSpace(code2) && size < max) {
      effects.consume(code2);
      size++;
      return prefix;
    }
    effects.exit(type);
    return after(code2);
  }
  function after(code2) {
    return size >= min ? ok3(code2) : nok(code2);
  }
}

// node_modules/micromark/lib/initialize/content.js
var content = {
  tokenize: initializeContent
};
function initializeContent(effects) {
  const contentStart = effects.attempt(this.parser.constructs.contentInitial, afterContentStartConstruct, paragraphInitial);
  let previous3;
  return contentStart;
  function afterContentStartConstruct(code2) {
    if (code2 === null) {
      effects.consume(code2);
      return;
    }
    effects.enter("lineEnding");
    effects.consume(code2);
    effects.exit("lineEnding");
    return factorySpace(effects, contentStart, "linePrefix");
  }
  function paragraphInitial(code2) {
    effects.enter("paragraph");
    return lineStart(code2);
  }
  function lineStart(code2) {
    const token = effects.enter("chunkText", {
      contentType: "text",
      previous: previous3
    });
    if (previous3) {
      previous3.next = token;
    }
    previous3 = token;
    return data(code2);
  }
  function data(code2) {
    if (code2 === null) {
      effects.exit("chunkText");
      effects.exit("paragraph");
      effects.consume(code2);
      return;
    }
    if (markdownLineEnding(code2)) {
      effects.consume(code2);
      effects.exit("chunkText");
      return lineStart;
    }
    effects.consume(code2);
    return data;
  }
}

// node_modules/micromark-util-edit-map/index.js
var EditMap = class {
  /**
   * Create a new edit map.
   *
   * @returns
   *   New instance.
   */
  constructor() {
    this.index = /* @__PURE__ */ new Map();
    this.map = [];
  }
  /**
   * Create an edit: a remove and/or add at a certain place.
   *
   * @param {number} index
   *   Index at which to apply the edit.
   * @param {number} remove
   *   Count of items to remove at the index.
   * @param {Array<Event>} add
   *   Items to add at the index.
   * @returns {undefined}
   *   Nothing.
   */
  add(index2, remove, add) {
    addImplementation(this, index2, remove, add, false);
  }
  /**
   * Create an edit: but insert `add` before existing additions, instead of
   * after them.
   *
   * @param {number} index
   *   Index at which to apply the edit.
   * @param {number} remove
   *   Count of items to remove at the index.
   * @param {Array<Event>} add
   *   Items to add at the index.
   * @returns {undefined}
   *   Nothing.
   */
  addBefore(index2, remove, add) {
    addImplementation(this, index2, remove, add, true);
  }
  /**
   * Done, change the events.
   *
   * @param {Array<Event>} events
   *   List of events to apply the edits to.
   * @returns {undefined}
   *   Nothing.
   */
  consume(events) {
    this.map.sort(function(a, b) {
      return a[0] - b[0];
    });
    if (this.map.length === 0) {
      return;
    }
    let index2 = this.map.length;
    const vecs = [];
    while (index2 > 0) {
      index2 -= 1;
      vecs.push(events.slice(this.map[index2][0] + this.map[index2][1]), this.map[index2][2]);
      events.length = this.map[index2][0];
    }
    vecs.push(events.slice());
    events.length = 0;
    let slice = vecs.pop();
    while (slice) {
      for (const element of slice) {
        events.push(element);
      }
      slice = vecs.pop();
    }
    this.map.length = 0;
    this.index.clear();
  }
};
function addImplementation(editMap, at, remove, add, before) {
  if (remove === 0 && add.length === 0) {
    return;
  }
  const existing = editMap.index.get(at);
  if (existing) {
    existing[1] += remove;
    if (before) {
      add.push(...existing[2]);
      existing[2] = add;
    } else {
      existing[2].push(...add);
    }
    return;
  }
  const change = [at, remove, add];
  editMap.map.push(change);
  editMap.index.set(at, change);
}

// node_modules/micromark/lib/initialize/document.js
var document = {
  tokenize: initializeDocument
};
var containerConstruct = {
  tokenize: tokenizeContainer
};
function initializeDocument(effects) {
  const self = this;
  const stack = [];
  let continued = 0;
  let childFlow;
  let childToken;
  let lineStartOffset;
  return start2;
  function start2(code2) {
    if (continued < stack.length) {
      const item = stack[continued];
      self.containerState = item[1];
      return effects.attempt(item[0].continuation, documentContinue, checkNewContainers)(code2);
    }
    return checkNewContainers(code2);
  }
  function documentContinue(code2) {
    continued++;
    if (self.containerState._closeFlow) {
      self.containerState._closeFlow = void 0;
      if (childFlow) {
        closeFlow();
      }
      const indexBeforeExits = self.events.length;
      let indexBeforeFlow = indexBeforeExits;
      let point3;
      while (indexBeforeFlow--) {
        if (self.events[indexBeforeFlow][0] === "exit" && self.events[indexBeforeFlow][1].type === "chunkFlow") {
          point3 = self.events[indexBeforeFlow][1].end;
          break;
        }
      }
      exitContainers(continued);
      let index2 = indexBeforeExits;
      while (index2 < self.events.length) {
        self.events[index2][1].end = {
          ...point3
        };
        index2++;
      }
      const editMap = new EditMap();
      editMap.add(indexBeforeFlow + 1, 0, self.events.slice(indexBeforeExits));
      editMap.add(indexBeforeExits, index2 - indexBeforeExits, []);
      editMap.consume(self.events);
      return checkNewContainers(code2);
    }
    return start2(code2);
  }
  function checkNewContainers(code2) {
    if (continued === stack.length) {
      if (!childFlow) {
        return documentContinued(code2);
      }
      if (childFlow.currentConstruct && childFlow.currentConstruct.concrete) {
        return flowStart(code2);
      }
      self.interrupt = Boolean(childFlow.currentConstruct && !childFlow._gfmTableDynamicInterruptHack);
    }
    self.containerState = {};
    return effects.check(containerConstruct, thereIsANewContainer, thereIsNoNewContainer)(code2);
  }
  function thereIsANewContainer(code2) {
    if (childFlow) {
      closeFlow();
    }
    exitContainers(continued);
    return documentContinued(code2);
  }
  function thereIsNoNewContainer(code2) {
    self.parser.lazy[self.now().line] = continued !== stack.length;
    lineStartOffset = self.now().offset;
    return flowStart(code2);
  }
  function documentContinued(code2) {
    self.containerState = {};
    return effects.attempt(containerConstruct, containerContinue, flowStart)(code2);
  }
  function containerContinue(code2) {
    continued++;
    stack.push([self.currentConstruct, self.containerState]);
    return documentContinued(code2);
  }
  function flowStart(code2) {
    if (code2 === null) {
      if (childFlow) {
        closeFlow();
      }
      exitContainers(0);
      effects.consume(code2);
      return;
    }
    childFlow = childFlow || self.parser.flow(self.now());
    effects.enter("chunkFlow", {
      _tokenizer: childFlow,
      contentType: "flow",
      previous: childToken
    });
    return flowContinue(code2);
  }
  function flowContinue(code2) {
    if (code2 === null) {
      writeToChild(effects.exit("chunkFlow"), true);
      exitContainers(0);
      effects.consume(code2);
      return;
    }
    if (markdownLineEnding(code2)) {
      effects.consume(code2);
      writeToChild(effects.exit("chunkFlow"));
      continued = 0;
      self.interrupt = void 0;
      return start2;
    }
    effects.consume(code2);
    return flowContinue;
  }
  function writeToChild(token, endOfFile) {
    const stream = self.sliceStream(token);
    if (endOfFile) {
      stream.push(null);
    }
    token.previous = childToken;
    if (childToken) {
      childToken.next = token;
    }
    childToken = token;
    childFlow.defineSkip(token.start);
    childFlow.write(stream);
    if (self.parser.lazy[token.start.line]) {
      let index2 = childFlow.events.length;
      while (index2--) {
        if (
          // The token starts before the line ending…
          childFlow.events[index2][1].start.offset < lineStartOffset && // …and either is not ended yet…
          (!childFlow.events[index2][1].end || // …or ends after it.
          childFlow.events[index2][1].end.offset > lineStartOffset)
        ) {
          return;
        }
      }
      const indexBeforeExits = self.events.length;
      let indexBeforeFlow = indexBeforeExits;
      let seen;
      let point3;
      while (indexBeforeFlow--) {
        if (self.events[indexBeforeFlow][0] === "exit" && self.events[indexBeforeFlow][1].type === "chunkFlow") {
          if (seen) {
            point3 = self.events[indexBeforeFlow][1].end;
            break;
          }
          seen = true;
        }
      }
      exitContainers(continued);
      index2 = indexBeforeExits;
      while (index2 < self.events.length) {
        self.events[index2][1].end = {
          ...point3
        };
        index2++;
      }
      const editMap = new EditMap();
      editMap.add(indexBeforeFlow + 1, 0, self.events.slice(indexBeforeExits));
      editMap.add(indexBeforeExits, index2 - indexBeforeExits, []);
      editMap.consume(self.events);
    }
  }
  function exitContainers(size) {
    let index2 = stack.length;
    while (index2-- > size) {
      const entry = stack[index2];
      self.containerState = entry[1];
      entry[0].exit.call(self, effects);
    }
    stack.length = size;
  }
  function closeFlow() {
    childFlow.write([null]);
    childToken = void 0;
    childFlow = void 0;
    self.containerState._closeFlow = void 0;
  }
}
function tokenizeContainer(effects, ok3, nok) {
  return factorySpace(effects, effects.attempt(this.parser.constructs.document, ok3, nok), "linePrefix", this.parser.constructs.disable.null.includes("codeIndented") ? void 0 : 4);
}

// node_modules/micromark-util-classify-character/index.js
function classifyCharacter(code2) {
  if (code2 === null || markdownLineEndingOrSpace(code2) || unicodeWhitespace(code2)) {
    return 1;
  }
  if (unicodePunctuation(code2)) {
    return 2;
  }
}

// node_modules/micromark-util-resolve-all/index.js
function resolveAll(constructs2, events, context) {
  const called = [];
  let index2 = -1;
  while (++index2 < constructs2.length) {
    const resolve3 = constructs2[index2].resolveAll;
    if (resolve3 && !called.includes(resolve3)) {
      events = resolve3(events, context);
      called.push(resolve3);
    }
  }
  return events;
}

// node_modules/micromark-core-commonmark/lib/attention.js
var attention = {
  name: "attention",
  resolveAll: resolveAllAttention,
  tokenize: tokenizeAttention
};
function resolveAllAttention(events, context) {
  let index2 = -1;
  let nextEvents;
  while (++index2 < events.length) {
    if (events[index2][0] === "enter" && events[index2][1].type === "attentionSequence" && events[index2][1]._close) {
      let open = index2;
      while (open--) {
        if (events[open][0] === "exit" && events[open][1].type === "attentionSequence" && events[open][1]._open && // If the markers are the same:
        context.sliceSerialize(events[open][1]).charCodeAt(0) === context.sliceSerialize(events[index2][1]).charCodeAt(0)) {
          if ((events[open][1]._close || events[index2][1]._open) && (events[index2][1].end.offset - events[index2][1].start.offset) % 3 && !((events[open][1].end.offset - events[open][1].start.offset + events[index2][1].end.offset - events[index2][1].start.offset) % 3)) {
            continue;
          }
          const use = events[open][1].end.offset - events[open][1].start.offset > 1 && events[index2][1].end.offset - events[index2][1].start.offset > 1 ? 2 : 1;
          const start2 = {
            ...events[open][1].end
          };
          const end2 = {
            ...events[index2][1].start
          };
          movePoint(start2, -use);
          movePoint(end2, use);
          const openingSequence = {
            type: use > 1 ? "strongSequence" : "emphasisSequence",
            start: start2,
            end: {
              ...events[open][1].end
            }
          };
          const closingSequence = {
            type: use > 1 ? "strongSequence" : "emphasisSequence",
            start: {
              ...events[index2][1].start
            },
            end: end2
          };
          const text4 = {
            type: use > 1 ? "strongText" : "emphasisText",
            start: {
              ...events[open][1].end
            },
            end: {
              ...events[index2][1].start
            }
          };
          const group = {
            type: use > 1 ? "strong" : "emphasis",
            start: {
              ...openingSequence.start
            },
            end: {
              ...closingSequence.end
            }
          };
          events[open][1].end = {
            ...openingSequence.start
          };
          events[index2][1].start = {
            ...closingSequence.end
          };
          nextEvents = [];
          if (events[open][1].end.offset - events[open][1].start.offset) {
            nextEvents = push(nextEvents, [["enter", events[open][1], context], ["exit", events[open][1], context]]);
          }
          nextEvents = push(nextEvents, [["enter", group, context], ["enter", openingSequence, context], ["exit", openingSequence, context], ["enter", text4, context]]);
          nextEvents = push(nextEvents, resolveAll(context.parser.constructs.insideSpan.null, events.slice(open + 1, index2), context));
          nextEvents = push(nextEvents, [["exit", text4, context], ["enter", closingSequence, context], ["exit", closingSequence, context], ["exit", group, context]]);
          let offset = 0;
          if (events[index2][1].end.offset - events[index2][1].start.offset) {
            offset = 2;
            nextEvents = push(nextEvents, [["enter", events[index2][1], context], ["exit", events[index2][1], context]]);
          }
          splice(events, open - 1, index2 - open + 3, nextEvents);
          index2 = open + nextEvents.length - offset - 2;
          break;
        }
      }
    }
  }
  index2 = -1;
  while (++index2 < events.length) {
    if (events[index2][1].type === "attentionSequence") {
      events[index2][1].type = "data";
    }
  }
  return events;
}
function tokenizeAttention(effects, ok3) {
  const attentionMarkers2 = this.parser.constructs.attentionMarkers.null;
  const previous3 = this.previous;
  const before = classifyCharacter(previous3);
  let marker;
  return start2;
  function start2(code2) {
    marker = code2;
    effects.enter("attentionSequence");
    return inside(code2);
  }
  function inside(code2) {
    if (code2 === marker) {
      effects.consume(code2);
      return inside;
    }
    const token = effects.exit("attentionSequence");
    const after = classifyCharacter(code2);
    const open = !after || after === 2 && before || attentionMarkers2.includes(code2) && code2 !== 42 && code2 !== 95;
    const close = !before || before === 2 && after || attentionMarkers2.includes(previous3) && previous3 !== 42 && previous3 !== 95;
    token._open = Boolean(marker === 42 ? open : open && (before || !close));
    token._close = Boolean(marker === 42 ? close : close && (after || !open));
    return ok3(code2);
  }
}
function movePoint(point3, offset) {
  point3.column += offset;
  point3.offset += offset;
  point3._bufferIndex += offset;
}

// node_modules/micromark-core-commonmark/lib/autolink.js
var autolink = {
  name: "autolink",
  tokenize: tokenizeAutolink
};
function tokenizeAutolink(effects, ok3, nok) {
  let size = 0;
  return start2;
  function start2(code2) {
    effects.enter("autolink");
    effects.enter("autolinkMarker");
    effects.consume(code2);
    effects.exit("autolinkMarker");
    effects.enter("autolinkProtocol");
    return open;
  }
  function open(code2) {
    if (asciiAlpha(code2)) {
      effects.consume(code2);
      return schemeOrEmailAtext;
    }
    if (code2 === 64) {
      return nok(code2);
    }
    return emailAtext(code2);
  }
  function schemeOrEmailAtext(code2) {
    if (code2 === 43 || code2 === 45 || code2 === 46 || asciiAlphanumeric(code2)) {
      size = 1;
      return schemeInsideOrEmailAtext(code2);
    }
    return emailAtext(code2);
  }
  function schemeInsideOrEmailAtext(code2) {
    if (code2 === 58) {
      effects.consume(code2);
      size = 0;
      return urlInside;
    }
    if ((code2 === 43 || code2 === 45 || code2 === 46 || asciiAlphanumeric(code2)) && size++ < 32) {
      effects.consume(code2);
      return schemeInsideOrEmailAtext;
    }
    size = 0;
    return emailAtext(code2);
  }
  function urlInside(code2) {
    if (code2 === 62) {
      effects.exit("autolinkProtocol");
      effects.enter("autolinkMarker");
      effects.consume(code2);
      effects.exit("autolinkMarker");
      effects.exit("autolink");
      return ok3;
    }
    if (code2 === null || code2 === 32 || code2 === 60 || asciiControl(code2)) {
      return nok(code2);
    }
    effects.consume(code2);
    return urlInside;
  }
  function emailAtext(code2) {
    if (code2 === 64) {
      effects.consume(code2);
      return emailAtSignOrDot;
    }
    if (asciiAtext(code2)) {
      effects.consume(code2);
      return emailAtext;
    }
    return nok(code2);
  }
  function emailAtSignOrDot(code2) {
    return asciiAlphanumeric(code2) ? emailLabel(code2) : nok(code2);
  }
  function emailLabel(code2) {
    if (code2 === 46) {
      effects.consume(code2);
      size = 0;
      return emailAtSignOrDot;
    }
    if (code2 === 62) {
      effects.exit("autolinkProtocol").type = "autolinkEmail";
      effects.enter("autolinkMarker");
      effects.consume(code2);
      effects.exit("autolinkMarker");
      effects.exit("autolink");
      return ok3;
    }
    return emailValue(code2);
  }
  function emailValue(code2) {
    if ((code2 === 45 || asciiAlphanumeric(code2)) && size++ < 63) {
      const next = code2 === 45 ? emailValue : emailLabel;
      effects.consume(code2);
      return next;
    }
    return nok(code2);
  }
}

// node_modules/micromark-core-commonmark/lib/blank-line.js
var blankLine = {
  partial: true,
  tokenize: tokenizeBlankLine
};
function tokenizeBlankLine(effects, ok3, nok) {
  return start2;
  function start2(code2) {
    return markdownSpace(code2) ? factorySpace(effects, after, "linePrefix")(code2) : after(code2);
  }
  function after(code2) {
    return code2 === null || markdownLineEnding(code2) ? ok3(code2) : nok(code2);
  }
}

// node_modules/micromark-core-commonmark/lib/block-quote.js
var blockQuote = {
  continuation: {
    tokenize: tokenizeBlockQuoteContinuation
  },
  exit,
  name: "blockQuote",
  tokenize: tokenizeBlockQuoteStart
};
function tokenizeBlockQuoteStart(effects, ok3, nok) {
  const self = this;
  return start2;
  function start2(code2) {
    if (code2 === 62) {
      const state = self.containerState;
      if (!state.open) {
        effects.enter("blockQuote", {
          _container: true
        });
        state.open = true;
      }
      effects.enter("blockQuotePrefix");
      effects.enter("blockQuoteMarker");
      effects.consume(code2);
      effects.exit("blockQuoteMarker");
      return after;
    }
    return nok(code2);
  }
  function after(code2) {
    if (markdownSpace(code2)) {
      effects.enter("blockQuotePrefixWhitespace");
      effects.consume(code2);
      effects.exit("blockQuotePrefixWhitespace");
      effects.exit("blockQuotePrefix");
      return ok3;
    }
    effects.exit("blockQuotePrefix");
    return ok3(code2);
  }
}
function tokenizeBlockQuoteContinuation(effects, ok3, nok) {
  const self = this;
  return contStart;
  function contStart(code2) {
    if (markdownSpace(code2)) {
      return factorySpace(effects, contBefore, "linePrefix", self.parser.constructs.disable.null.includes("codeIndented") ? void 0 : 4)(code2);
    }
    return contBefore(code2);
  }
  function contBefore(code2) {
    return effects.attempt(blockQuote, ok3, nok)(code2);
  }
}
function exit(effects) {
  effects.exit("blockQuote");
}

// node_modules/micromark-core-commonmark/lib/character-escape.js
var characterEscape = {
  name: "characterEscape",
  tokenize: tokenizeCharacterEscape
};
function tokenizeCharacterEscape(effects, ok3, nok) {
  return start2;
  function start2(code2) {
    effects.enter("characterEscape");
    effects.enter("escapeMarker");
    effects.consume(code2);
    effects.exit("escapeMarker");
    return inside;
  }
  function inside(code2) {
    if (asciiPunctuation(code2)) {
      effects.enter("characterEscapeValue");
      effects.consume(code2);
      effects.exit("characterEscapeValue");
      effects.exit("characterEscape");
      return ok3;
    }
    return nok(code2);
  }
}

// node_modules/micromark-core-commonmark/lib/character-reference.js
var characterReference = {
  name: "characterReference",
  tokenize: tokenizeCharacterReference
};
function tokenizeCharacterReference(effects, ok3, nok) {
  const self = this;
  let size = 0;
  let max;
  let test;
  return start2;
  function start2(code2) {
    effects.enter("characterReference");
    effects.enter("characterReferenceMarker");
    effects.consume(code2);
    effects.exit("characterReferenceMarker");
    return open;
  }
  function open(code2) {
    if (code2 === 35) {
      effects.enter("characterReferenceMarkerNumeric");
      effects.consume(code2);
      effects.exit("characterReferenceMarkerNumeric");
      return numeric;
    }
    effects.enter("characterReferenceValue");
    max = 31;
    test = asciiAlphanumeric;
    return value(code2);
  }
  function numeric(code2) {
    if (code2 === 88 || code2 === 120) {
      effects.enter("characterReferenceMarkerHexadecimal");
      effects.consume(code2);
      effects.exit("characterReferenceMarkerHexadecimal");
      effects.enter("characterReferenceValue");
      max = 6;
      test = asciiHexDigit;
      return value;
    }
    effects.enter("characterReferenceValue");
    max = 7;
    test = asciiDigit;
    return value(code2);
  }
  function value(code2) {
    if (code2 === 59 && size) {
      const token = effects.exit("characterReferenceValue");
      if (test === asciiAlphanumeric && !decodeNamedCharacterReference(self.sliceSerialize(token))) {
        return nok(code2);
      }
      effects.enter("characterReferenceMarker");
      effects.consume(code2);
      effects.exit("characterReferenceMarker");
      effects.exit("characterReference");
      return ok3;
    }
    if (test(code2) && size++ < max) {
      effects.consume(code2);
      return value;
    }
    return nok(code2);
  }
}

// node_modules/micromark-core-commonmark/lib/partial-non-lazy-continuation.js
var nonLazyContinuation = {
  partial: true,
  tokenize: tokenizeNonLazyContinuation
};
function tokenizeNonLazyContinuation(effects, ok3, nok) {
  const self = this;
  return start2;
  function start2(code2) {
    if (code2 === null) {
      return nok(code2);
    }
    effects.enter("lineEnding");
    effects.consume(code2);
    effects.exit("lineEnding");
    return after;
  }
  function after(code2) {
    return self.parser.lazy[self.now().line] ? nok(code2) : ok3(code2);
  }
}

// node_modules/micromark-core-commonmark/lib/code-fenced.js
var codeFenced = {
  concrete: true,
  name: "codeFenced",
  tokenize: tokenizeCodeFenced
};
function tokenizeCodeFenced(effects, ok3, nok) {
  const self = this;
  const closeStart = {
    partial: true,
    tokenize: tokenizeCloseStart
  };
  let initialPrefix = 0;
  let sizeOpen = 0;
  let marker;
  return start2;
  function start2(code2) {
    return beforeSequenceOpen(code2);
  }
  function beforeSequenceOpen(code2) {
    const tail = self.events[self.events.length - 1];
    initialPrefix = tail && tail[1].type === "linePrefix" ? tail[2].sliceSerialize(tail[1], true).length : 0;
    marker = code2;
    effects.enter("codeFenced");
    effects.enter("codeFencedFence");
    effects.enter("codeFencedFenceSequence");
    return sequenceOpen(code2);
  }
  function sequenceOpen(code2) {
    if (code2 === marker) {
      sizeOpen++;
      effects.consume(code2);
      return sequenceOpen;
    }
    if (sizeOpen < 3) {
      return nok(code2);
    }
    effects.exit("codeFencedFenceSequence");
    return markdownSpace(code2) ? factorySpace(effects, infoBefore, "whitespace")(code2) : infoBefore(code2);
  }
  function infoBefore(code2) {
    if (code2 === null || markdownLineEnding(code2)) {
      effects.exit("codeFencedFence");
      return self.interrupt ? ok3(code2) : effects.check(nonLazyContinuation, atNonLazyBreak, after)(code2);
    }
    effects.enter("codeFencedFenceInfo");
    effects.enter("chunkString", {
      contentType: "string"
    });
    return info(code2);
  }
  function info(code2) {
    if (code2 === null || markdownLineEnding(code2)) {
      effects.exit("chunkString");
      effects.exit("codeFencedFenceInfo");
      return infoBefore(code2);
    }
    if (markdownSpace(code2)) {
      effects.exit("chunkString");
      effects.exit("codeFencedFenceInfo");
      return factorySpace(effects, metaBefore, "whitespace")(code2);
    }
    if (code2 === 96 && code2 === marker) {
      return nok(code2);
    }
    effects.consume(code2);
    return info;
  }
  function metaBefore(code2) {
    if (code2 === null || markdownLineEnding(code2)) {
      return infoBefore(code2);
    }
    effects.enter("codeFencedFenceMeta");
    effects.enter("chunkString", {
      contentType: "string"
    });
    return meta(code2);
  }
  function meta(code2) {
    if (code2 === null || markdownLineEnding(code2)) {
      effects.exit("chunkString");
      effects.exit("codeFencedFenceMeta");
      return infoBefore(code2);
    }
    if (code2 === 96 && code2 === marker) {
      return nok(code2);
    }
    effects.consume(code2);
    return meta;
  }
  function atNonLazyBreak(code2) {
    return effects.attempt(closeStart, after, contentBefore)(code2);
  }
  function contentBefore(code2) {
    effects.enter("lineEnding");
    effects.consume(code2);
    effects.exit("lineEnding");
    return contentStart;
  }
  function contentStart(code2) {
    return initialPrefix > 0 && markdownSpace(code2) ? factorySpace(effects, beforeContentChunk, "linePrefix", initialPrefix + 1)(code2) : beforeContentChunk(code2);
  }
  function beforeContentChunk(code2) {
    if (code2 === null || markdownLineEnding(code2)) {
      return effects.check(nonLazyContinuation, atNonLazyBreak, after)(code2);
    }
    effects.enter("codeFlowValue");
    return contentChunk(code2);
  }
  function contentChunk(code2) {
    if (code2 === null || markdownLineEnding(code2)) {
      effects.exit("codeFlowValue");
      return beforeContentChunk(code2);
    }
    effects.consume(code2);
    return contentChunk;
  }
  function after(code2) {
    effects.exit("codeFenced");
    return ok3(code2);
  }
  function tokenizeCloseStart(effects2, ok4, nok2) {
    let size = 0;
    return startBefore;
    function startBefore(code2) {
      effects2.enter("lineEnding");
      effects2.consume(code2);
      effects2.exit("lineEnding");
      return start3;
    }
    function start3(code2) {
      effects2.enter("codeFencedFence");
      return markdownSpace(code2) ? factorySpace(effects2, beforeSequenceClose, "linePrefix", self.parser.constructs.disable.null.includes("codeIndented") ? void 0 : 4)(code2) : beforeSequenceClose(code2);
    }
    function beforeSequenceClose(code2) {
      if (code2 === marker) {
        effects2.enter("codeFencedFenceSequence");
        return sequenceClose(code2);
      }
      return nok2(code2);
    }
    function sequenceClose(code2) {
      if (code2 === marker) {
        size++;
        effects2.consume(code2);
        return sequenceClose;
      }
      if (size >= sizeOpen) {
        effects2.exit("codeFencedFenceSequence");
        return markdownSpace(code2) ? factorySpace(effects2, sequenceCloseAfter, "whitespace")(code2) : sequenceCloseAfter(code2);
      }
      return nok2(code2);
    }
    function sequenceCloseAfter(code2) {
      if (code2 === null || markdownLineEnding(code2)) {
        effects2.exit("codeFencedFence");
        return ok4(code2);
      }
      return nok2(code2);
    }
  }
}

// node_modules/micromark-core-commonmark/lib/code-indented.js
var codeIndented = {
  name: "codeIndented",
  tokenize: tokenizeCodeIndented
};
var furtherStart = {
  partial: true,
  tokenize: tokenizeFurtherStart
};
function tokenizeCodeIndented(effects, ok3, nok) {
  return start2;
  function start2(code2) {
    effects.enter("codeIndented");
    return factorySpaceMinMax(effects, atBreak, nok, "linePrefix", 4, 4)(code2);
  }
  function atBreak(code2) {
    if (code2 === null) {
      return after(code2);
    }
    if (markdownLineEnding(code2)) {
      return effects.attempt(furtherStart, atBreak, after)(code2);
    }
    effects.enter("codeFlowValue");
    return inside(code2);
  }
  function inside(code2) {
    if (code2 === null || markdownLineEnding(code2)) {
      effects.exit("codeFlowValue");
      return atBreak(code2);
    }
    effects.consume(code2);
    return inside;
  }
  function after(code2) {
    effects.exit("codeIndented");
    return ok3(code2);
  }
}
function tokenizeFurtherStart(effects, ok3, nok) {
  const self = this;
  return furtherStart2;
  function furtherStart2(code2) {
    if (self.parser.lazy[self.now().line]) {
      return nok(code2);
    }
    if (markdownLineEnding(code2)) {
      effects.enter("lineEnding");
      effects.consume(code2);
      effects.exit("lineEnding");
      return furtherStart2;
    }
    return factorySpaceMinMax(effects, ok3, onNotEnoughPrefix, "linePrefix", 4, 4)(code2);
  }
  function onNotEnoughPrefix(code2) {
    return markdownLineEnding(code2) ? furtherStart2(code2) : nok(code2);
  }
}

// node_modules/micromark-core-commonmark/lib/code-text.js
var codeText = {
  name: "codeText",
  previous,
  resolve: resolveCodeText,
  tokenize: tokenizeCodeText
};
function resolveCodeText(events) {
  let tailExitIndex = events.length - 4;
  let headEnterIndex = 3;
  let index2;
  let enter;
  if ((events[headEnterIndex][1].type === "lineEnding" || events[headEnterIndex][1].type === "space") && (events[tailExitIndex][1].type === "lineEnding" || events[tailExitIndex][1].type === "space")) {
    index2 = headEnterIndex;
    while (++index2 < tailExitIndex) {
      if (events[index2][1].type === "codeTextData") {
        events[headEnterIndex][1].type = "codeTextPadding";
        events[tailExitIndex][1].type = "codeTextPadding";
        headEnterIndex += 2;
        tailExitIndex -= 2;
        break;
      }
    }
  }
  index2 = headEnterIndex - 1;
  tailExitIndex++;
  while (++index2 <= tailExitIndex) {
    if (enter === void 0) {
      if (index2 !== tailExitIndex && events[index2][1].type !== "lineEnding") {
        enter = index2;
      }
    } else if (index2 === tailExitIndex || events[index2][1].type === "lineEnding") {
      events[enter][1].type = "codeTextData";
      if (index2 !== enter + 2) {
        events[enter][1].end = events[index2 - 1][1].end;
        events.splice(enter + 2, index2 - enter - 2);
        tailExitIndex -= index2 - enter - 2;
        index2 = enter + 2;
      }
      enter = void 0;
    }
  }
  return events;
}
function previous(code2) {
  return code2 !== 96 || this.events[this.events.length - 1][1].type === "characterEscape";
}
function tokenizeCodeText(effects, ok3, nok) {
  const self = this;
  let sizeOpen = 0;
  let size;
  let token;
  return start2;
  function start2(code2) {
    effects.enter("codeText");
    effects.enter("codeTextSequence");
    return sequenceOpen(code2);
  }
  function sequenceOpen(code2) {
    if (code2 === 96) {
      effects.consume(code2);
      sizeOpen++;
      return sequenceOpen;
    }
    effects.exit("codeTextSequence");
    return between(code2);
  }
  function between(code2) {
    if (code2 === null) {
      return nok(code2);
    }
    if (code2 === 32) {
      effects.enter("space");
      effects.consume(code2);
      effects.exit("space");
      return between;
    }
    if (code2 === 96) {
      token = effects.enter("codeTextSequence");
      size = 0;
      return sequenceClose(code2);
    }
    if (markdownLineEnding(code2)) {
      effects.enter("lineEnding");
      effects.consume(code2);
      effects.exit("lineEnding");
      return between;
    }
    effects.enter("codeTextData");
    return data(code2);
  }
  function data(code2) {
    if (code2 === null || code2 === 32 || code2 === 96 || markdownLineEnding(code2)) {
      effects.exit("codeTextData");
      return between(code2);
    }
    effects.consume(code2);
    return data;
  }
  function sequenceClose(code2) {
    if (code2 === 96) {
      effects.consume(code2);
      size++;
      return sequenceClose;
    }
    if (size === sizeOpen) {
      effects.exit("codeTextSequence");
      effects.exit("codeText");
      return ok3(code2);
    }
    token.type = "codeTextData";
    return data(code2);
  }
}

// node_modules/micromark-util-subtokenize/lib/splice-buffer.js
var SpliceBuffer = class {
  /**
   * @param {ReadonlyArray<T> | null | undefined} [initial]
   *   Initial items (optional).
   * @returns
   *   Splice buffer.
   */
  constructor(initial) {
    this.left = initial ? [...initial] : [];
    this.right = [];
  }
  /**
   * Array access;
   * does not move the cursor.
   *
   * @param {number} index
   *   Index.
   * @return {T}
   *   Item.
   */
  get(index2) {
    if (index2 < 0 || index2 >= this.left.length + this.right.length) {
      throw new RangeError("Cannot access index `" + index2 + "` in a splice buffer of size `" + (this.left.length + this.right.length) + "`");
    }
    if (index2 < this.left.length) return this.left[index2];
    return this.right[this.right.length - index2 + this.left.length - 1];
  }
  /**
   * The length of the splice buffer, one greater than the largest index in the
   * array.
   */
  get length() {
    return this.left.length + this.right.length;
  }
  /**
   * Remove and return `list[0]`;
   * moves the cursor to `0`.
   *
   * @returns {T | undefined}
   *   Item, optional.
   */
  shift() {
    this.setCursor(0);
    return this.right.pop();
  }
  /**
   * Slice the buffer to get an array;
   * does not move the cursor.
   *
   * @param {number} start
   *   Start.
   * @param {number | null | undefined} [end]
   *   End (optional).
   * @returns {Array<T>}
   *   Array of items.
   */
  slice(start2, end2) {
    const stop = end2 === null || end2 === void 0 ? Number.POSITIVE_INFINITY : end2;
    if (stop < this.left.length) {
      return this.left.slice(start2, stop);
    }
    if (start2 > this.left.length) {
      return this.right.slice(this.right.length - stop + this.left.length, this.right.length - start2 + this.left.length).reverse();
    }
    return this.left.slice(start2).concat(this.right.slice(this.right.length - stop + this.left.length).reverse());
  }
  /**
   * Mimics the behavior of Array.prototype.splice() except for the change of
   * interface necessary to avoid segfaults when patching in very large arrays.
   *
   * This operation moves cursor is moved to `start` and results in the cursor
   * placed after any inserted items.
   *
   * @param {number} start
   *   Start;
   *   zero-based index at which to start changing the array;
   *   negative numbers count backwards from the end of the array and values
   *   that are out-of bounds are clamped to the appropriate end of the array.
   * @param {number | null | undefined} [deleteCount=0]
   *   Delete count (default: `0`);
   *   maximum number of elements to delete, starting from start.
   * @param {Array<T> | null | undefined} [items=[]]
   *   Items to include in place of the deleted items (default: `[]`).
   * @return {Array<T>}
   *   Any removed items.
   */
  splice(start2, deleteCount, items) {
    const count4 = deleteCount || 0;
    this.setCursor(Math.trunc(start2));
    const removed = this.right.splice(this.right.length - count4, Number.POSITIVE_INFINITY);
    if (items) chunkedPush(this.left, items);
    return removed.reverse();
  }
  /**
   * Remove and return the highest-numbered item in the array, so
   * `list[list.length - 1]`;
   * Moves the cursor to `length`.
   *
   * @returns {T | undefined}
   *   Item, optional.
   */
  pop() {
    this.setCursor(Number.POSITIVE_INFINITY);
    return this.left.pop();
  }
  /**
   * Inserts a single item to the high-numbered side of the array;
   * moves the cursor to `length`.
   *
   * @param {T} item
   *   Item.
   * @returns {undefined}
   *   Nothing.
   */
  push(item) {
    this.setCursor(Number.POSITIVE_INFINITY);
    this.left.push(item);
  }
  /**
   * Inserts many items to the high-numbered side of the array.
   * Moves the cursor to `length`.
   *
   * @param {Array<T>} items
   *   Items.
   * @returns {undefined}
   *   Nothing.
   */
  pushMany(items) {
    this.setCursor(Number.POSITIVE_INFINITY);
    chunkedPush(this.left, items);
  }
  /**
   * Inserts a single item to the low-numbered side of the array;
   * Moves the cursor to `0`.
   *
   * @param {T} item
   *   Item.
   * @returns {undefined}
   *   Nothing.
   */
  unshift(item) {
    this.setCursor(0);
    this.right.push(item);
  }
  /**
   * Inserts many items to the low-numbered side of the array;
   * moves the cursor to `0`.
   *
   * @param {Array<T>} items
   *   Items.
   * @returns {undefined}
   *   Nothing.
   */
  unshiftMany(items) {
    this.setCursor(0);
    chunkedPush(this.right, items.reverse());
  }
  /**
   * Move the cursor to a specific position in the array. Requires
   * time proportional to the distance moved.
   *
   * If `n < 0`, the cursor will end up at the beginning.
   * If `n > length`, the cursor will end up at the end.
   *
   * @param {number} n
   *   Position.
   * @return {undefined}
   *   Nothing.
   */
  setCursor(n) {
    if (n === this.left.length || n > this.left.length && this.right.length === 0 || n < 0 && this.left.length === 0) return;
    if (n < this.left.length) {
      const removed = this.left.splice(n, Number.POSITIVE_INFINITY);
      chunkedPush(this.right, removed.reverse());
    } else {
      const removed = this.right.splice(this.left.length + this.right.length - n, Number.POSITIVE_INFINITY);
      chunkedPush(this.left, removed.reverse());
    }
  }
};
function chunkedPush(list2, right) {
  let chunkStart = 0;
  if (right.length < 1e4) {
    list2.push(...right);
  } else {
    while (chunkStart < right.length) {
      list2.push(...right.slice(chunkStart, chunkStart + 1e4));
      chunkStart += 1e4;
    }
  }
}

// node_modules/micromark-util-subtokenize/index.js
function subtokenize(eventsArray) {
  const jumps = {};
  let index2 = -1;
  let event;
  let lineIndex;
  let otherIndex;
  let otherEvent;
  let parameters;
  let subevents;
  let more;
  const events = new SpliceBuffer(eventsArray);
  while (++index2 < events.length) {
    while (index2 in jumps) {
      index2 = jumps[index2];
    }
    event = events.get(index2);
    if (index2 && event[1].type === "chunkFlow" && events.get(index2 - 1)[1].type === "listItemPrefix") {
      subevents = event[1]._tokenizer.events;
      otherIndex = 0;
      if (otherIndex < subevents.length && subevents[otherIndex][1].type === "lineEndingBlank") {
        otherIndex += 2;
      }
      if (otherIndex < subevents.length && subevents[otherIndex][1].type === "content") {
        while (++otherIndex < subevents.length) {
          if (subevents[otherIndex][1].type === "content") {
            break;
          }
          if (subevents[otherIndex][1].type === "chunkText") {
            subevents[otherIndex][1]._isInFirstContentOfListItem = true;
            otherIndex++;
          }
        }
      }
    }
    if (event[0] === "enter") {
      if (event[1].contentType) {
        Object.assign(jumps, subcontent(events, index2));
        index2 = jumps[index2];
        more = true;
      }
    } else if (event[1]._container) {
      otherIndex = index2;
      lineIndex = void 0;
      while (otherIndex--) {
        otherEvent = events.get(otherIndex);
        if (otherEvent[1].type === "lineEnding" || otherEvent[1].type === "lineEndingBlank") {
          if (otherEvent[0] === "enter") {
            if (lineIndex) {
              events.get(lineIndex)[1].type = "lineEndingBlank";
            }
            otherEvent[1].type = "lineEnding";
            lineIndex = otherIndex;
          }
        } else if (otherEvent[1].type === "linePrefix" || otherEvent[1].type === "listItemIndent") {
        } else {
          break;
        }
      }
      if (lineIndex) {
        event[1].end = {
          ...events.get(lineIndex)[1].start
        };
        parameters = events.slice(lineIndex, index2);
        parameters.unshift(event);
        events.splice(lineIndex, index2 - lineIndex + 1, parameters);
      }
    }
  }
  splice(eventsArray, 0, Number.POSITIVE_INFINITY, events.slice(0));
  return !more;
}
function subcontent(events, eventIndex) {
  const token = events.get(eventIndex)[1];
  const context = events.get(eventIndex)[2];
  let startPosition = eventIndex - 1;
  const startPositions = [];
  let tokenizer = token._tokenizer;
  if (!tokenizer) {
    tokenizer = context.parser[token.contentType](token.start);
    if (token._contentTypeTextTrailing) {
      tokenizer._contentTypeTextTrailing = true;
    }
  }
  const childEvents = tokenizer.events;
  const jumps = [];
  const gaps = {};
  let stream;
  let previous3;
  let index2 = -1;
  let current = token;
  let adjust = 0;
  let start2 = 0;
  const breaks = [start2];
  while (current) {
    while (events.get(++startPosition)[1] !== current) {
    }
    startPositions.push(startPosition);
    if (!current._tokenizer) {
      stream = context.sliceStream(current);
      if (!current.next) {
        stream.push(null);
      }
      if (previous3) {
        tokenizer.defineSkip(current.start);
      }
      if (current._isInFirstContentOfListItem) {
        tokenizer._gfmTasklistFirstContentOfListItem = true;
      }
      tokenizer.write(stream);
      if (current._isInFirstContentOfListItem) {
        tokenizer._gfmTasklistFirstContentOfListItem = void 0;
      }
    }
    previous3 = current;
    current = current.next;
  }
  current = token;
  while (++index2 < childEvents.length) {
    if (
      // Find a void token that includes a break.
      childEvents[index2][0] === "exit" && childEvents[index2 - 1][0] === "enter" && childEvents[index2][1].type === childEvents[index2 - 1][1].type && childEvents[index2][1].start.line !== childEvents[index2][1].end.line
    ) {
      start2 = index2 + 1;
      breaks.push(start2);
      current._tokenizer = void 0;
      current.previous = void 0;
      current = current.next;
    }
  }
  tokenizer.events = [];
  if (current) {
    current._tokenizer = void 0;
    current.previous = void 0;
  } else {
    breaks.pop();
  }
  index2 = breaks.length;
  while (index2--) {
    const slice = childEvents.slice(breaks[index2], breaks[index2 + 1]);
    const start3 = startPositions.pop();
    jumps.push([start3, start3 + slice.length - 1]);
    events.splice(start3, 2, slice);
  }
  jumps.reverse();
  index2 = -1;
  while (++index2 < jumps.length) {
    gaps[adjust + jumps[index2][0]] = adjust + jumps[index2][1];
    adjust += jumps[index2][1] - jumps[index2][0] - 1;
  }
  return gaps;
}

// node_modules/micromark-core-commonmark/lib/content.js
var content2 = {
  resolve: resolveContent,
  tokenize: tokenizeContent
};
var continuationConstruct = {
  partial: true,
  tokenize: tokenizeContinuation
};
function resolveContent(events) {
  subtokenize(events);
  return events;
}
function tokenizeContent(effects, ok3) {
  let previous3;
  return chunkStart;
  function chunkStart(code2) {
    effects.enter("content");
    previous3 = effects.enter("chunkContent", {
      contentType: "content"
    });
    return chunkInside(code2);
  }
  function chunkInside(code2) {
    if (code2 === null) {
      return contentEnd(code2);
    }
    if (markdownLineEnding(code2)) {
      return effects.check(continuationConstruct, contentContinue, contentEnd)(code2);
    }
    effects.consume(code2);
    return chunkInside;
  }
  function contentEnd(code2) {
    effects.exit("chunkContent");
    effects.exit("content");
    return ok3(code2);
  }
  function contentContinue(code2) {
    effects.consume(code2);
    effects.exit("chunkContent");
    previous3.next = effects.enter("chunkContent", {
      contentType: "content",
      previous: previous3
    });
    previous3 = previous3.next;
    return chunkInside;
  }
}
function tokenizeContinuation(effects, ok3, nok) {
  const self = this;
  return startLookahead;
  function startLookahead(code2) {
    effects.exit("chunkContent");
    effects.enter("lineEnding");
    effects.consume(code2);
    effects.exit("lineEnding");
    return factorySpace(effects, prefixed, "linePrefix");
  }
  function prefixed(code2) {
    if (code2 === null || markdownLineEnding(code2)) {
      return nok(code2);
    }
    const tail = self.events[self.events.length - 1];
    if (!self.parser.constructs.disable.null.includes("codeIndented") && tail && tail[1].type === "linePrefix" && tail[2].sliceSerialize(tail[1], true).length >= 4) {
      return ok3(code2);
    }
    return effects.interrupt(self.parser.constructs.flow, nok, ok3)(code2);
  }
}

// node_modules/micromark-factory-destination/index.js
function factoryDestination(effects, ok3, nok, type, literalType, literalMarkerType, rawType, stringType, max) {
  const limit = max || Number.POSITIVE_INFINITY;
  let balance = 0;
  return start2;
  function start2(code2) {
    if (code2 === 60) {
      effects.enter(type);
      effects.enter(literalType);
      effects.enter(literalMarkerType);
      effects.consume(code2);
      effects.exit(literalMarkerType);
      return enclosedBefore;
    }
    if (code2 === null || code2 === 32 || code2 === 41 || asciiControl(code2)) {
      return nok(code2);
    }
    effects.enter(type);
    effects.enter(rawType);
    effects.enter(stringType);
    effects.enter("chunkString", {
      contentType: "string"
    });
    return raw(code2);
  }
  function enclosedBefore(code2) {
    if (code2 === 62) {
      effects.enter(literalMarkerType);
      effects.consume(code2);
      effects.exit(literalMarkerType);
      effects.exit(literalType);
      effects.exit(type);
      return ok3;
    }
    effects.enter(stringType);
    effects.enter("chunkString", {
      contentType: "string"
    });
    return enclosed(code2);
  }
  function enclosed(code2) {
    if (code2 === 62) {
      effects.exit("chunkString");
      effects.exit(stringType);
      return enclosedBefore(code2);
    }
    if (code2 === null || code2 === 60 || markdownLineEnding(code2)) {
      return nok(code2);
    }
    effects.consume(code2);
    return code2 === 92 ? enclosedEscape : enclosed;
  }
  function enclosedEscape(code2) {
    if (code2 === 60 || code2 === 62 || code2 === 92) {
      effects.consume(code2);
      return enclosed;
    }
    return enclosed(code2);
  }
  function raw(code2) {
    if (!balance && (code2 === null || code2 === 41 || markdownLineEndingOrSpace(code2))) {
      effects.exit("chunkString");
      effects.exit(stringType);
      effects.exit(rawType);
      effects.exit(type);
      return ok3(code2);
    }
    if (balance < limit && code2 === 40) {
      effects.consume(code2);
      balance++;
      return raw;
    }
    if (code2 === 41) {
      effects.consume(code2);
      balance--;
      return raw;
    }
    if (code2 === null || code2 === 32 || code2 === 40 || asciiControl(code2)) {
      return nok(code2);
    }
    effects.consume(code2);
    return code2 === 92 ? rawEscape : raw;
  }
  function rawEscape(code2) {
    if (code2 === 40 || code2 === 41 || code2 === 92) {
      effects.consume(code2);
      return raw;
    }
    return raw(code2);
  }
}

// node_modules/micromark-factory-label/index.js
function factoryLabel(effects, ok3, nok, type, markerType, stringType) {
  const self = this;
  let size = 0;
  let seen;
  return start2;
  function start2(code2) {
    effects.enter(type);
    effects.enter(markerType);
    effects.consume(code2);
    effects.exit(markerType);
    effects.enter(stringType);
    return atBreak;
  }
  function atBreak(code2) {
    if (size > 999 || code2 === null || code2 === 91 || code2 === 93 && !seen || // To do: remove in the future once we’ve switched from
    // `micromark-extension-footnote` to `micromark-extension-gfm-footnote`,
    // which doesn’t need this.
    // Hidden footnotes hook.
    /* c8 ignore next 3 */
    code2 === 94 && !size && "_hiddenFootnoteSupport" in self.parser.constructs) {
      return nok(code2);
    }
    if (code2 === 93) {
      effects.exit(stringType);
      effects.enter(markerType);
      effects.consume(code2);
      effects.exit(markerType);
      effects.exit(type);
      return ok3;
    }
    if (markdownLineEnding(code2)) {
      effects.enter("lineEnding");
      effects.consume(code2);
      effects.exit("lineEnding");
      return atBreak;
    }
    effects.enter("chunkString", {
      contentType: "string"
    });
    return labelInside(code2);
  }
  function labelInside(code2) {
    if (code2 === null || code2 === 91 || code2 === 93 || markdownLineEnding(code2) || size++ > 999) {
      effects.exit("chunkString");
      return atBreak(code2);
    }
    effects.consume(code2);
    if (!seen) seen = !markdownSpace(code2);
    return code2 === 92 ? labelEscape : labelInside;
  }
  function labelEscape(code2) {
    if (code2 === 91 || code2 === 92 || code2 === 93) {
      effects.consume(code2);
      size++;
      return labelInside;
    }
    return labelInside(code2);
  }
}

// node_modules/micromark-factory-title/index.js
function factoryTitle(effects, ok3, nok, type, markerType, stringType) {
  let marker;
  return start2;
  function start2(code2) {
    if (code2 === 34 || code2 === 39 || code2 === 40) {
      effects.enter(type);
      effects.enter(markerType);
      effects.consume(code2);
      effects.exit(markerType);
      marker = code2 === 40 ? 41 : code2;
      return begin;
    }
    return nok(code2);
  }
  function begin(code2) {
    if (code2 === marker) {
      effects.enter(markerType);
      effects.consume(code2);
      effects.exit(markerType);
      effects.exit(type);
      return ok3;
    }
    effects.enter(stringType);
    return atBreak(code2);
  }
  function atBreak(code2) {
    if (code2 === marker) {
      effects.exit(stringType);
      return begin(marker);
    }
    if (code2 === null) {
      return nok(code2);
    }
    if (markdownLineEnding(code2)) {
      effects.enter("lineEnding");
      effects.consume(code2);
      effects.exit("lineEnding");
      return factorySpace(effects, atBreak, "linePrefix");
    }
    effects.enter("chunkString", {
      contentType: "string"
    });
    return inside(code2);
  }
  function inside(code2) {
    if (code2 === marker || code2 === null || markdownLineEnding(code2)) {
      effects.exit("chunkString");
      return atBreak(code2);
    }
    effects.consume(code2);
    return code2 === 92 ? escape : inside;
  }
  function escape(code2) {
    if (code2 === marker || code2 === 92) {
      effects.consume(code2);
      return inside;
    }
    return inside(code2);
  }
}

// node_modules/micromark-factory-whitespace/index.js
function factoryWhitespace(effects, ok3) {
  let seen;
  return start2;
  function start2(code2) {
    if (markdownLineEnding(code2)) {
      effects.enter("lineEnding");
      effects.consume(code2);
      effects.exit("lineEnding");
      seen = true;
      return start2;
    }
    if (markdownSpace(code2)) {
      return factorySpace(effects, start2, seen ? "linePrefix" : "lineSuffix")(code2);
    }
    return ok3(code2);
  }
}

// node_modules/micromark-core-commonmark/lib/definition.js
var definition = {
  name: "definition",
  tokenize: tokenizeDefinition
};
var titleBefore = {
  partial: true,
  tokenize: tokenizeTitleBefore
};
function tokenizeDefinition(effects, ok3, nok) {
  const self = this;
  let identifier;
  return start2;
  function start2(code2) {
    effects.enter("definition");
    return before(code2);
  }
  function before(code2) {
    return factoryLabel.call(
      self,
      effects,
      labelAfter,
      // Note: we don’t need to reset the way `markdown-rs` does.
      nok,
      "definitionLabel",
      "definitionLabelMarker",
      "definitionLabelString"
    )(code2);
  }
  function labelAfter(code2) {
    identifier = normalizeIdentifier(self.sliceSerialize(self.events[self.events.length - 1][1]).slice(1, -1));
    if (code2 === 58) {
      effects.enter("definitionMarker");
      effects.consume(code2);
      effects.exit("definitionMarker");
      return markerAfter;
    }
    return nok(code2);
  }
  function markerAfter(code2) {
    return markdownLineEndingOrSpace(code2) ? factoryWhitespace(effects, destinationBefore)(code2) : destinationBefore(code2);
  }
  function destinationBefore(code2) {
    return factoryDestination(
      effects,
      destinationAfter,
      // Note: we don’t need to reset the way `markdown-rs` does.
      nok,
      "definitionDestination",
      "definitionDestinationLiteral",
      "definitionDestinationLiteralMarker",
      "definitionDestinationRaw",
      "definitionDestinationString"
    )(code2);
  }
  function destinationAfter(code2) {
    return effects.attempt(titleBefore, after, after)(code2);
  }
  function after(code2) {
    return markdownSpace(code2) ? factorySpace(effects, afterWhitespace, "whitespace")(code2) : afterWhitespace(code2);
  }
  function afterWhitespace(code2) {
    if (code2 === null || markdownLineEnding(code2)) {
      effects.exit("definition");
      self.parser.defined.push(identifier);
      return ok3(code2);
    }
    return nok(code2);
  }
}
function tokenizeTitleBefore(effects, ok3, nok) {
  return titleBefore2;
  function titleBefore2(code2) {
    return markdownLineEndingOrSpace(code2) ? factoryWhitespace(effects, beforeMarker)(code2) : nok(code2);
  }
  function beforeMarker(code2) {
    return factoryTitle(effects, titleAfter, nok, "definitionTitle", "definitionTitleMarker", "definitionTitleString")(code2);
  }
  function titleAfter(code2) {
    return markdownSpace(code2) ? factorySpace(effects, titleAfterOptionalWhitespace, "whitespace")(code2) : titleAfterOptionalWhitespace(code2);
  }
  function titleAfterOptionalWhitespace(code2) {
    return code2 === null || markdownLineEnding(code2) ? ok3(code2) : nok(code2);
  }
}

// node_modules/micromark-core-commonmark/lib/hard-break-escape.js
var hardBreakEscape = {
  name: "hardBreakEscape",
  tokenize: tokenizeHardBreakEscape
};
function tokenizeHardBreakEscape(effects, ok3, nok) {
  return start2;
  function start2(code2) {
    effects.enter("hardBreakEscape");
    effects.consume(code2);
    return after;
  }
  function after(code2) {
    if (markdownLineEnding(code2)) {
      effects.exit("hardBreakEscape");
      return ok3(code2);
    }
    return nok(code2);
  }
}

// node_modules/micromark-core-commonmark/lib/heading-atx.js
var headingAtx = {
  name: "headingAtx",
  resolve: resolveHeadingAtx,
  tokenize: tokenizeHeadingAtx
};
function resolveHeadingAtx(events, context) {
  let contentEnd = events.length - 2;
  let contentStart = 3;
  if (events[contentStart][1].type === "whitespace") {
    contentStart += 2;
  }
  if (contentEnd - 2 > contentStart && events[contentEnd][1].type === "whitespace") {
    contentEnd -= 2;
  }
  if (events[contentEnd][1].type === "atxHeadingSequence" && (contentStart === contentEnd - 1 || contentEnd - 4 > contentStart && events[contentEnd - 2][1].type === "whitespace")) {
    contentEnd -= contentStart + 1 === contentEnd ? 2 : 4;
  }
  if (contentEnd > contentStart) {
    const content4 = {
      type: "atxHeadingText",
      start: events[contentStart][1].start,
      end: events[contentEnd][1].end
    };
    const text4 = {
      type: "chunkText",
      start: events[contentStart][1].start,
      end: events[contentEnd][1].end,
      contentType: "text"
    };
    splice(events, contentStart, contentEnd - contentStart + 1, [["enter", content4, context], ["enter", text4, context], ["exit", text4, context], ["exit", content4, context]]);
  }
  return events;
}
function tokenizeHeadingAtx(effects, ok3, nok) {
  let size = 0;
  return start2;
  function start2(code2) {
    effects.enter("atxHeading");
    return before(code2);
  }
  function before(code2) {
    effects.enter("atxHeadingSequence");
    return sequenceOpen(code2);
  }
  function sequenceOpen(code2) {
    if (code2 === 35 && size++ < 6) {
      effects.consume(code2);
      return sequenceOpen;
    }
    if (code2 === null || markdownLineEndingOrSpace(code2)) {
      effects.exit("atxHeadingSequence");
      return atBreak(code2);
    }
    return nok(code2);
  }
  function atBreak(code2) {
    if (code2 === 35) {
      effects.enter("atxHeadingSequence");
      return sequenceFurther(code2);
    }
    if (code2 === null || markdownLineEnding(code2)) {
      effects.exit("atxHeading");
      return ok3(code2);
    }
    if (markdownSpace(code2)) {
      return factorySpace(effects, atBreak, "whitespace")(code2);
    }
    effects.enter("atxHeadingText");
    return data(code2);
  }
  function sequenceFurther(code2) {
    if (code2 === 35) {
      effects.consume(code2);
      return sequenceFurther;
    }
    effects.exit("atxHeadingSequence");
    return atBreak(code2);
  }
  function data(code2) {
    if (code2 === null || code2 === 35 || markdownLineEndingOrSpace(code2)) {
      effects.exit("atxHeadingText");
      return atBreak(code2);
    }
    effects.consume(code2);
    return data;
  }
}

// node_modules/micromark-util-html-tag-name/index.js
var htmlBlockNames = [
  "address",
  "article",
  "aside",
  "base",
  "basefont",
  "blockquote",
  "body",
  "caption",
  "center",
  "col",
  "colgroup",
  "dd",
  "details",
  "dialog",
  "dir",
  "div",
  "dl",
  "dt",
  "fieldset",
  "figcaption",
  "figure",
  "footer",
  "form",
  "frame",
  "frameset",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "head",
  "header",
  "hr",
  "html",
  "iframe",
  "legend",
  "li",
  "link",
  "main",
  "menu",
  "menuitem",
  "nav",
  "noframes",
  "ol",
  "optgroup",
  "option",
  "p",
  "param",
  "search",
  "section",
  "summary",
  "table",
  "tbody",
  "td",
  "tfoot",
  "th",
  "thead",
  "title",
  "tr",
  "track",
  "ul"
];
var htmlRawNames = ["pre", "script", "style", "textarea"];

// node_modules/micromark-core-commonmark/lib/html-flow.js
var htmlFlow = {
  concrete: true,
  name: "htmlFlow",
  resolveTo: resolveToHtmlFlow,
  tokenize: tokenizeHtmlFlow
};
var blankLineBefore = {
  partial: true,
  tokenize: tokenizeBlankLineBefore
};
function resolveToHtmlFlow(events) {
  let index2 = events.length;
  while (index2--) {
    if (events[index2][0] === "enter" && events[index2][1].type === "htmlFlow") {
      break;
    }
  }
  if (index2 > 1 && events[index2 - 2][1].type === "linePrefix") {
    events[index2][1].start = events[index2 - 2][1].start;
    events[index2 + 1][1].start = events[index2 - 2][1].start;
    events.splice(index2 - 2, 2);
  }
  return events;
}
function tokenizeHtmlFlow(effects, ok3, nok) {
  const self = this;
  let marker;
  let closingTag;
  let buffer;
  let index2;
  let markerB;
  return start2;
  function start2(code2) {
    return before(code2);
  }
  function before(code2) {
    effects.enter("htmlFlow");
    effects.enter("htmlFlowData");
    effects.consume(code2);
    return open;
  }
  function open(code2) {
    if (code2 === 33) {
      effects.consume(code2);
      return declarationOpen;
    }
    if (code2 === 47) {
      effects.consume(code2);
      closingTag = true;
      return tagCloseStart;
    }
    if (code2 === 63) {
      effects.consume(code2);
      marker = 3;
      return self.interrupt ? ok3 : continuationDeclarationInside;
    }
    if (asciiAlpha(code2)) {
      effects.consume(code2);
      buffer = String.fromCharCode(code2);
      return tagName;
    }
    return nok(code2);
  }
  function declarationOpen(code2) {
    if (code2 === 45) {
      effects.consume(code2);
      marker = 2;
      return commentOpenInside;
    }
    if (code2 === 91) {
      effects.consume(code2);
      marker = 5;
      index2 = 0;
      return cdataOpenInside;
    }
    if (asciiAlpha(code2)) {
      effects.consume(code2);
      marker = 4;
      return self.interrupt ? ok3 : continuationDeclarationInside;
    }
    return nok(code2);
  }
  function commentOpenInside(code2) {
    if (code2 === 45) {
      effects.consume(code2);
      return self.interrupt ? ok3 : continuationDeclarationInside;
    }
    return nok(code2);
  }
  function cdataOpenInside(code2) {
    const value = "CDATA[";
    if (code2 === value.charCodeAt(index2++)) {
      effects.consume(code2);
      if (index2 === value.length) {
        return self.interrupt ? ok3 : continuation;
      }
      return cdataOpenInside;
    }
    return nok(code2);
  }
  function tagCloseStart(code2) {
    if (asciiAlpha(code2)) {
      effects.consume(code2);
      buffer = String.fromCharCode(code2);
      return tagName;
    }
    return nok(code2);
  }
  function tagName(code2) {
    if (code2 === null || code2 === 47 || code2 === 62 || markdownLineEndingOrSpace(code2)) {
      const slash = code2 === 47;
      const name = buffer.toLowerCase();
      if (!slash && !closingTag && htmlRawNames.includes(name)) {
        marker = 1;
        return self.interrupt ? ok3(code2) : continuation(code2);
      }
      if (htmlBlockNames.includes(buffer.toLowerCase())) {
        marker = 6;
        if (slash) {
          effects.consume(code2);
          return basicSelfClosing;
        }
        return self.interrupt ? ok3(code2) : continuation(code2);
      }
      marker = 7;
      return self.interrupt && !self.parser.lazy[self.now().line] ? nok(code2) : closingTag ? completeClosingTagAfter(code2) : completeAttributeNameBefore(code2);
    }
    if (code2 === 45 || asciiAlphanumeric(code2)) {
      effects.consume(code2);
      buffer += String.fromCharCode(code2);
      return tagName;
    }
    return nok(code2);
  }
  function basicSelfClosing(code2) {
    if (code2 === 62) {
      effects.consume(code2);
      return self.interrupt ? ok3 : continuation;
    }
    return nok(code2);
  }
  function completeClosingTagAfter(code2) {
    if (markdownSpace(code2)) {
      effects.consume(code2);
      return completeClosingTagAfter;
    }
    return completeEnd(code2);
  }
  function completeAttributeNameBefore(code2) {
    if (code2 === 47) {
      effects.consume(code2);
      return completeEnd;
    }
    if (code2 === 58 || code2 === 95 || asciiAlpha(code2)) {
      effects.consume(code2);
      return completeAttributeName;
    }
    if (markdownSpace(code2)) {
      effects.consume(code2);
      return completeAttributeNameBefore;
    }
    return completeEnd(code2);
  }
  function completeAttributeName(code2) {
    if (code2 === 45 || code2 === 46 || code2 === 58 || code2 === 95 || asciiAlphanumeric(code2)) {
      effects.consume(code2);
      return completeAttributeName;
    }
    return completeAttributeNameAfter(code2);
  }
  function completeAttributeNameAfter(code2) {
    if (code2 === 61) {
      effects.consume(code2);
      return completeAttributeValueBefore;
    }
    if (markdownSpace(code2)) {
      effects.consume(code2);
      return completeAttributeNameAfter;
    }
    return completeAttributeNameBefore(code2);
  }
  function completeAttributeValueBefore(code2) {
    if (code2 === null || code2 === 60 || code2 === 61 || code2 === 62 || code2 === 96) {
      return nok(code2);
    }
    if (code2 === 34 || code2 === 39) {
      effects.consume(code2);
      markerB = code2;
      return completeAttributeValueQuoted;
    }
    if (markdownSpace(code2)) {
      effects.consume(code2);
      return completeAttributeValueBefore;
    }
    return completeAttributeValueUnquoted(code2);
  }
  function completeAttributeValueQuoted(code2) {
    if (code2 === markerB) {
      effects.consume(code2);
      markerB = null;
      return completeAttributeValueQuotedAfter;
    }
    if (code2 === null || markdownLineEnding(code2)) {
      return nok(code2);
    }
    effects.consume(code2);
    return completeAttributeValueQuoted;
  }
  function completeAttributeValueUnquoted(code2) {
    if (code2 === null || code2 === 34 || code2 === 39 || code2 === 47 || code2 === 60 || code2 === 61 || code2 === 62 || code2 === 96 || markdownLineEndingOrSpace(code2)) {
      return completeAttributeNameAfter(code2);
    }
    effects.consume(code2);
    return completeAttributeValueUnquoted;
  }
  function completeAttributeValueQuotedAfter(code2) {
    if (code2 === 47 || code2 === 62 || markdownSpace(code2)) {
      return completeAttributeNameBefore(code2);
    }
    return nok(code2);
  }
  function completeEnd(code2) {
    if (code2 === 62) {
      effects.consume(code2);
      return completeAfter;
    }
    return nok(code2);
  }
  function completeAfter(code2) {
    if (code2 === null || markdownLineEnding(code2)) {
      return continuation(code2);
    }
    if (markdownSpace(code2)) {
      effects.consume(code2);
      return completeAfter;
    }
    return nok(code2);
  }
  function continuation(code2) {
    if (code2 === 45 && marker === 2) {
      effects.consume(code2);
      return continuationCommentInside;
    }
    if (code2 === 60 && marker === 1) {
      effects.consume(code2);
      return continuationRawTagOpen;
    }
    if (code2 === 62 && marker === 4) {
      effects.consume(code2);
      return continuationClose;
    }
    if (code2 === 63 && marker === 3) {
      effects.consume(code2);
      return continuationDeclarationInside;
    }
    if (code2 === 93 && marker === 5) {
      effects.consume(code2);
      return continuationCdataInside;
    }
    if (markdownLineEnding(code2) && (marker === 6 || marker === 7)) {
      effects.exit("htmlFlowData");
      return effects.check(blankLineBefore, continuationAfter, continuationStart)(code2);
    }
    if (code2 === null || markdownLineEnding(code2)) {
      effects.exit("htmlFlowData");
      return continuationStart(code2);
    }
    effects.consume(code2);
    return continuation;
  }
  function continuationStart(code2) {
    return effects.check(nonLazyContinuation, continuationStartNonLazy, continuationAfter)(code2);
  }
  function continuationStartNonLazy(code2) {
    effects.enter("lineEnding");
    effects.consume(code2);
    effects.exit("lineEnding");
    return continuationBefore;
  }
  function continuationBefore(code2) {
    if (code2 === null || markdownLineEnding(code2)) {
      return continuationStart(code2);
    }
    effects.enter("htmlFlowData");
    return continuation(code2);
  }
  function continuationCommentInside(code2) {
    if (code2 === 45) {
      effects.consume(code2);
      return continuationDeclarationInside;
    }
    return continuation(code2);
  }
  function continuationRawTagOpen(code2) {
    if (code2 === 47) {
      effects.consume(code2);
      buffer = "";
      return continuationRawEndTag;
    }
    return continuation(code2);
  }
  function continuationRawEndTag(code2) {
    if (code2 === 62) {
      const name = buffer.toLowerCase();
      if (htmlRawNames.includes(name)) {
        effects.consume(code2);
        return continuationClose;
      }
      return continuation(code2);
    }
    if (asciiAlpha(code2) && buffer.length < 8) {
      effects.consume(code2);
      buffer += String.fromCharCode(code2);
      return continuationRawEndTag;
    }
    return continuation(code2);
  }
  function continuationCdataInside(code2) {
    if (code2 === 93) {
      effects.consume(code2);
      return continuationDeclarationInside;
    }
    return continuation(code2);
  }
  function continuationDeclarationInside(code2) {
    if (code2 === 62) {
      effects.consume(code2);
      return continuationClose;
    }
    if (code2 === 45 && marker === 2) {
      effects.consume(code2);
      return continuationDeclarationInside;
    }
    return continuation(code2);
  }
  function continuationClose(code2) {
    if (code2 === null || markdownLineEnding(code2)) {
      effects.exit("htmlFlowData");
      return continuationAfter(code2);
    }
    effects.consume(code2);
    return continuationClose;
  }
  function continuationAfter(code2) {
    effects.exit("htmlFlow");
    return ok3(code2);
  }
}
function tokenizeBlankLineBefore(effects, ok3, nok) {
  return start2;
  function start2(code2) {
    effects.enter("lineEnding");
    effects.consume(code2);
    effects.exit("lineEnding");
    return effects.attempt(blankLine, ok3, nok);
  }
}

// node_modules/micromark-core-commonmark/lib/html-text.js
var htmlText = {
  name: "htmlText",
  tokenize: tokenizeHtmlText
};
function tokenizeHtmlText(effects, ok3, nok) {
  const self = this;
  let marker;
  let index2;
  let returnState;
  return start2;
  function start2(code2) {
    effects.enter("htmlText");
    effects.enter("htmlTextData");
    effects.consume(code2);
    return open;
  }
  function open(code2) {
    if (code2 === 33) {
      effects.consume(code2);
      return declarationOpen;
    }
    if (code2 === 47) {
      effects.consume(code2);
      return tagCloseStart;
    }
    if (code2 === 63) {
      effects.consume(code2);
      return instruction;
    }
    if (asciiAlpha(code2)) {
      effects.consume(code2);
      return tagOpen;
    }
    return nok(code2);
  }
  function declarationOpen(code2) {
    if (code2 === 45) {
      effects.consume(code2);
      return commentOpenInside;
    }
    if (code2 === 91) {
      effects.consume(code2);
      index2 = 0;
      return cdataOpenInside;
    }
    if (asciiAlpha(code2)) {
      effects.consume(code2);
      return declaration;
    }
    return nok(code2);
  }
  function commentOpenInside(code2) {
    if (code2 === 45) {
      effects.consume(code2);
      return commentEnd;
    }
    return nok(code2);
  }
  function comment(code2) {
    if (code2 === null) {
      return nok(code2);
    }
    if (code2 === 45) {
      effects.consume(code2);
      return commentClose;
    }
    if (markdownLineEnding(code2)) {
      returnState = comment;
      return lineEndingBefore(code2);
    }
    effects.consume(code2);
    return comment;
  }
  function commentClose(code2) {
    if (code2 === 45) {
      effects.consume(code2);
      return commentEnd;
    }
    return comment(code2);
  }
  function commentEnd(code2) {
    return code2 === 62 ? end2(code2) : code2 === 45 ? commentClose(code2) : comment(code2);
  }
  function cdataOpenInside(code2) {
    const value = "CDATA[";
    if (code2 === value.charCodeAt(index2++)) {
      effects.consume(code2);
      return index2 === value.length ? cdata : cdataOpenInside;
    }
    return nok(code2);
  }
  function cdata(code2) {
    if (code2 === null) {
      return nok(code2);
    }
    if (code2 === 93) {
      effects.consume(code2);
      return cdataClose;
    }
    if (markdownLineEnding(code2)) {
      returnState = cdata;
      return lineEndingBefore(code2);
    }
    effects.consume(code2);
    return cdata;
  }
  function cdataClose(code2) {
    if (code2 === 93) {
      effects.consume(code2);
      return cdataEnd;
    }
    return cdata(code2);
  }
  function cdataEnd(code2) {
    if (code2 === 62) {
      return end2(code2);
    }
    if (code2 === 93) {
      effects.consume(code2);
      return cdataEnd;
    }
    return cdata(code2);
  }
  function declaration(code2) {
    if (code2 === null || code2 === 62) {
      return end2(code2);
    }
    if (markdownLineEnding(code2)) {
      returnState = declaration;
      return lineEndingBefore(code2);
    }
    effects.consume(code2);
    return declaration;
  }
  function instruction(code2) {
    if (code2 === null) {
      return nok(code2);
    }
    if (code2 === 63) {
      effects.consume(code2);
      return instructionClose;
    }
    if (markdownLineEnding(code2)) {
      returnState = instruction;
      return lineEndingBefore(code2);
    }
    effects.consume(code2);
    return instruction;
  }
  function instructionClose(code2) {
    return code2 === 62 ? end2(code2) : instruction(code2);
  }
  function tagCloseStart(code2) {
    if (asciiAlpha(code2)) {
      effects.consume(code2);
      return tagClose;
    }
    return nok(code2);
  }
  function tagClose(code2) {
    if (code2 === 45 || asciiAlphanumeric(code2)) {
      effects.consume(code2);
      return tagClose;
    }
    return tagCloseBetween(code2);
  }
  function tagCloseBetween(code2) {
    if (markdownLineEnding(code2)) {
      returnState = tagCloseBetween;
      return lineEndingBefore(code2);
    }
    if (markdownSpace(code2)) {
      effects.consume(code2);
      return tagCloseBetween;
    }
    return end2(code2);
  }
  function tagOpen(code2) {
    if (code2 === 45 || asciiAlphanumeric(code2)) {
      effects.consume(code2);
      return tagOpen;
    }
    if (code2 === 47 || code2 === 62 || markdownLineEndingOrSpace(code2)) {
      return tagOpenBetween(code2);
    }
    return nok(code2);
  }
  function tagOpenBetween(code2) {
    if (code2 === 47) {
      effects.consume(code2);
      return end2;
    }
    if (code2 === 58 || code2 === 95 || asciiAlpha(code2)) {
      effects.consume(code2);
      return tagOpenAttributeName;
    }
    if (markdownLineEnding(code2)) {
      returnState = tagOpenBetween;
      return lineEndingBefore(code2);
    }
    if (markdownSpace(code2)) {
      effects.consume(code2);
      return tagOpenBetween;
    }
    return end2(code2);
  }
  function tagOpenAttributeName(code2) {
    if (code2 === 45 || code2 === 46 || code2 === 58 || code2 === 95 || asciiAlphanumeric(code2)) {
      effects.consume(code2);
      return tagOpenAttributeName;
    }
    return tagOpenAttributeNameAfter(code2);
  }
  function tagOpenAttributeNameAfter(code2) {
    if (code2 === 61) {
      effects.consume(code2);
      return tagOpenAttributeValueBefore;
    }
    if (markdownLineEnding(code2)) {
      returnState = tagOpenAttributeNameAfter;
      return lineEndingBefore(code2);
    }
    if (markdownSpace(code2)) {
      effects.consume(code2);
      return tagOpenAttributeNameAfter;
    }
    return tagOpenBetween(code2);
  }
  function tagOpenAttributeValueBefore(code2) {
    if (code2 === null || code2 === 60 || code2 === 61 || code2 === 62 || code2 === 96) {
      return nok(code2);
    }
    if (code2 === 34 || code2 === 39) {
      effects.consume(code2);
      marker = code2;
      return tagOpenAttributeValueQuoted;
    }
    if (markdownLineEnding(code2)) {
      returnState = tagOpenAttributeValueBefore;
      return lineEndingBefore(code2);
    }
    if (markdownSpace(code2)) {
      effects.consume(code2);
      return tagOpenAttributeValueBefore;
    }
    effects.consume(code2);
    return tagOpenAttributeValueUnquoted;
  }
  function tagOpenAttributeValueQuoted(code2) {
    if (code2 === marker) {
      effects.consume(code2);
      marker = void 0;
      return tagOpenAttributeValueQuotedAfter;
    }
    if (code2 === null) {
      return nok(code2);
    }
    if (markdownLineEnding(code2)) {
      returnState = tagOpenAttributeValueQuoted;
      return lineEndingBefore(code2);
    }
    effects.consume(code2);
    return tagOpenAttributeValueQuoted;
  }
  function tagOpenAttributeValueUnquoted(code2) {
    if (code2 === null || code2 === 34 || code2 === 39 || code2 === 60 || code2 === 61 || code2 === 96) {
      return nok(code2);
    }
    if (code2 === 47 || code2 === 62 || markdownLineEndingOrSpace(code2)) {
      return tagOpenBetween(code2);
    }
    effects.consume(code2);
    return tagOpenAttributeValueUnquoted;
  }
  function tagOpenAttributeValueQuotedAfter(code2) {
    if (code2 === 47 || code2 === 62 || markdownLineEndingOrSpace(code2)) {
      return tagOpenBetween(code2);
    }
    return nok(code2);
  }
  function end2(code2) {
    if (code2 === 62) {
      effects.consume(code2);
      effects.exit("htmlTextData");
      effects.exit("htmlText");
      return ok3;
    }
    return nok(code2);
  }
  function lineEndingBefore(code2) {
    effects.exit("htmlTextData");
    effects.enter("lineEnding");
    effects.consume(code2);
    effects.exit("lineEnding");
    return lineEndingAfter;
  }
  function lineEndingAfter(code2) {
    return markdownSpace(code2) ? factorySpace(effects, lineEndingAfterPrefix, "linePrefix", self.parser.constructs.disable.null.includes("codeIndented") ? void 0 : 4)(code2) : lineEndingAfterPrefix(code2);
  }
  function lineEndingAfterPrefix(code2) {
    effects.enter("htmlTextData");
    return returnState(code2);
  }
}

// node_modules/micromark-core-commonmark/lib/label-end.js
var labelEnd = {
  name: "labelEnd",
  resolveAll: resolveAllLabelEnd,
  resolveTo: resolveToLabelEnd,
  tokenize: tokenizeLabelEnd
};
var resourceConstruct = {
  tokenize: tokenizeResource
};
var referenceFullConstruct = {
  tokenize: tokenizeReferenceFull
};
var referenceCollapsedConstruct = {
  tokenize: tokenizeReferenceCollapsed
};
function resolveAllLabelEnd(events) {
  let index2 = -1;
  const newEvents = [];
  while (++index2 < events.length) {
    const token = events[index2][1];
    newEvents.push(events[index2]);
    if (token.type === "labelImage" || token.type === "labelLink" || token.type === "labelEnd") {
      const offset = token.type === "labelImage" ? 4 : 2;
      token.type = "data";
      index2 += offset;
    }
  }
  if (events.length !== newEvents.length) {
    splice(events, 0, events.length, newEvents);
  }
  return events;
}
function resolveToLabelEnd(events, context) {
  let index2 = events.length;
  let offset = 0;
  let open;
  let close;
  let media;
  while (index2--) {
    const token = events[index2][1];
    if (open) {
      if (token.type === "link" || token.type === "labelLink" && token._inactive) {
        break;
      }
      if (events[index2][0] === "enter" && token.type === "labelLink") {
        token._inactive = true;
      }
    } else if (close) {
      if (events[index2][0] === "enter" && (token.type === "labelImage" || token.type === "labelLink") && !token._balanced) {
        open = index2;
        if (token.type !== "labelLink") {
          offset = 2;
          break;
        }
      }
    } else if (token.type === "labelEnd") {
      close = index2;
    }
  }
  const group = {
    type: events[open][1].type === "labelLink" ? "link" : "image",
    start: {
      ...events[open][1].start
    },
    end: {
      ...events[events.length - 1][1].end
    }
  };
  const label = {
    type: "label",
    start: {
      ...events[open][1].start
    },
    end: {
      ...events[close][1].end
    }
  };
  const text4 = {
    type: "labelText",
    start: {
      ...events[open + offset + 2][1].end
    },
    end: {
      ...events[close - 2][1].start
    }
  };
  media = [["enter", group, context], ["enter", label, context]];
  media = push(media, events.slice(open + 1, open + offset + 3));
  media = push(media, [["enter", text4, context]]);
  media = push(media, resolveAll(context.parser.constructs.insideSpan.null, events.slice(open + offset + 4, close - 3), context));
  media = push(media, [["exit", text4, context], events[close - 2], events[close - 1], ["exit", label, context]]);
  media = push(media, events.slice(close + 1));
  media = push(media, [["exit", group, context]]);
  splice(events, open, events.length, media);
  return events;
}
function tokenizeLabelEnd(effects, ok3, nok) {
  const self = this;
  const labelStarts = self._labelStarts;
  let labelStart;
  let defined;
  if (labelStarts) {
    while (labelStarts.length > 0 && labelStarts[labelStarts.length - 1]._balanced) {
      labelStarts.pop();
    }
    labelStart = labelStarts[labelStarts.length - 1];
  }
  return start2;
  function start2(code2) {
    if (!labelStart) {
      return nok(code2);
    }
    if (labelStart._inactive) {
      return labelEndNok(code2);
    }
    defined = self.parser.defined.includes(normalizeIdentifier(self.sliceSerialize({
      start: labelStart.end,
      end: self.now()
    })));
    effects.enter("labelEnd");
    effects.enter("labelMarker");
    effects.consume(code2);
    effects.exit("labelMarker");
    effects.exit("labelEnd");
    return after;
  }
  function after(code2) {
    if (code2 === 40) {
      return effects.attempt(resourceConstruct, labelEndOk, defined ? labelEndOk : labelEndNok)(code2);
    }
    if (code2 === 91) {
      return effects.attempt(referenceFullConstruct, labelEndOk, defined ? referenceNotFull : labelEndNok)(code2);
    }
    return defined ? labelEndOk(code2) : labelEndNok(code2);
  }
  function referenceNotFull(code2) {
    return effects.attempt(referenceCollapsedConstruct, labelEndOk, labelEndNok)(code2);
  }
  function labelEndOk(code2) {
    labelStarts.pop();
    return ok3(code2);
  }
  function labelEndNok(code2) {
    labelStart._balanced = true;
    return nok(code2);
  }
}
function tokenizeResource(effects, ok3, nok) {
  return resourceStart;
  function resourceStart(code2) {
    effects.enter("resource");
    effects.enter("resourceMarker");
    effects.consume(code2);
    effects.exit("resourceMarker");
    return resourceBefore;
  }
  function resourceBefore(code2) {
    return markdownLineEndingOrSpace(code2) ? factoryWhitespace(effects, resourceOpen)(code2) : resourceOpen(code2);
  }
  function resourceOpen(code2) {
    if (code2 === 41) {
      return resourceEnd(code2);
    }
    return factoryDestination(effects, resourceDestinationAfter, resourceDestinationMissing, "resourceDestination", "resourceDestinationLiteral", "resourceDestinationLiteralMarker", "resourceDestinationRaw", "resourceDestinationString", 32)(code2);
  }
  function resourceDestinationAfter(code2) {
    return markdownLineEndingOrSpace(code2) ? factoryWhitespace(effects, resourceBetween)(code2) : resourceEnd(code2);
  }
  function resourceDestinationMissing(code2) {
    return nok(code2);
  }
  function resourceBetween(code2) {
    if (code2 === 34 || code2 === 39 || code2 === 40) {
      return factoryTitle(effects, resourceTitleAfter, nok, "resourceTitle", "resourceTitleMarker", "resourceTitleString")(code2);
    }
    return resourceEnd(code2);
  }
  function resourceTitleAfter(code2) {
    return markdownLineEndingOrSpace(code2) ? factoryWhitespace(effects, resourceEnd)(code2) : resourceEnd(code2);
  }
  function resourceEnd(code2) {
    if (code2 === 41) {
      effects.enter("resourceMarker");
      effects.consume(code2);
      effects.exit("resourceMarker");
      effects.exit("resource");
      return ok3;
    }
    return nok(code2);
  }
}
function tokenizeReferenceFull(effects, ok3, nok) {
  const self = this;
  return referenceFull;
  function referenceFull(code2) {
    return factoryLabel.call(self, effects, referenceFullAfter, referenceFullMissing, "reference", "referenceMarker", "referenceString")(code2);
  }
  function referenceFullAfter(code2) {
    return self.parser.defined.includes(normalizeIdentifier(self.sliceSerialize(self.events[self.events.length - 1][1]).slice(1, -1))) ? ok3(code2) : nok(code2);
  }
  function referenceFullMissing(code2) {
    return nok(code2);
  }
}
function tokenizeReferenceCollapsed(effects, ok3, nok) {
  return referenceCollapsedStart;
  function referenceCollapsedStart(code2) {
    effects.enter("reference");
    effects.enter("referenceMarker");
    effects.consume(code2);
    effects.exit("referenceMarker");
    return referenceCollapsedOpen;
  }
  function referenceCollapsedOpen(code2) {
    if (code2 === 93) {
      effects.enter("referenceMarker");
      effects.consume(code2);
      effects.exit("referenceMarker");
      effects.exit("reference");
      return ok3;
    }
    return nok(code2);
  }
}

// node_modules/micromark-core-commonmark/lib/label-start-image.js
var labelStartImage = {
  name: "labelStartImage",
  resolveAll: labelEnd.resolveAll,
  tokenize: tokenizeLabelStartImage
};
function tokenizeLabelStartImage(effects, ok3, nok) {
  const self = this;
  let labelImage;
  return start2;
  function start2(code2) {
    effects.enter("labelImage");
    effects.enter("labelImageMarker");
    effects.consume(code2);
    effects.exit("labelImageMarker");
    return open;
  }
  function open(code2) {
    if (code2 === 91) {
      effects.enter("labelMarker");
      effects.consume(code2);
      effects.exit("labelMarker");
      labelImage = effects.exit("labelImage");
      return after;
    }
    return nok(code2);
  }
  function after(code2) {
    if (code2 === 94 && "_hiddenFootnoteSupport" in self.parser.constructs) {
      return nok(code2);
    }
    self._labelStarts = self._labelStarts || [];
    self._labelStarts.push(labelImage);
    return ok3(code2);
  }
}

// node_modules/micromark-core-commonmark/lib/label-start-link.js
var labelStartLink = {
  name: "labelStartLink",
  resolveAll: labelEnd.resolveAll,
  tokenize: tokenizeLabelStartLink
};
function tokenizeLabelStartLink(effects, ok3, nok) {
  const self = this;
  let labelLink;
  return start2;
  function start2(code2) {
    effects.enter("labelLink");
    effects.enter("labelMarker");
    effects.consume(code2);
    effects.exit("labelMarker");
    labelLink = effects.exit("labelLink");
    return after;
  }
  function after(code2) {
    if (code2 === 94 && "_hiddenFootnoteSupport" in self.parser.constructs) {
      return nok(code2);
    }
    self._labelStarts = self._labelStarts || [];
    self._labelStarts.push(labelLink);
    return ok3(code2);
  }
}

// node_modules/micromark-core-commonmark/lib/line-ending.js
var lineEnding = {
  name: "lineEnding",
  tokenize: tokenizeLineEnding
};
function tokenizeLineEnding(effects, ok3) {
  return start2;
  function start2(code2) {
    effects.enter("lineEnding");
    effects.consume(code2);
    effects.exit("lineEnding");
    return factorySpace(effects, ok3, "linePrefix");
  }
}

// node_modules/micromark-core-commonmark/lib/thematic-break.js
var thematicBreak = {
  name: "thematicBreak",
  tokenize: tokenizeThematicBreak
};
function tokenizeThematicBreak(effects, ok3, nok) {
  let size = 0;
  let marker;
  return start2;
  function start2(code2) {
    effects.enter("thematicBreak");
    return before(code2);
  }
  function before(code2) {
    marker = code2;
    return atBreak(code2);
  }
  function atBreak(code2) {
    if (code2 === marker) {
      effects.enter("thematicBreakSequence");
      return sequence(code2);
    }
    if (size >= 3 && (code2 === null || markdownLineEnding(code2))) {
      effects.exit("thematicBreak");
      return ok3(code2);
    }
    return nok(code2);
  }
  function sequence(code2) {
    if (code2 === marker) {
      effects.consume(code2);
      size++;
      return sequence;
    }
    effects.exit("thematicBreakSequence");
    return markdownSpace(code2) ? factorySpace(effects, atBreak, "whitespace")(code2) : atBreak(code2);
  }
}

// node_modules/micromark-core-commonmark/lib/list.js
var list = {
  continuation: {
    tokenize: tokenizeListContinuation
  },
  exit: tokenizeListEnd,
  name: "list",
  tokenize: tokenizeListStart
};
var listItemPrefixWhitespaceConstruct = {
  partial: true,
  tokenize: tokenizeListItemPrefixWhitespace
};
var indentConstruct = {
  partial: true,
  tokenize: tokenizeIndent
};
function tokenizeListStart(effects, ok3, nok) {
  const self = this;
  const tail = self.events[self.events.length - 1];
  let initialSize = tail && tail[1].type === "linePrefix" ? tail[2].sliceSerialize(tail[1], true).length : 0;
  let size = 0;
  return start2;
  function start2(code2) {
    const kind = self.containerState.type || (code2 === 42 || code2 === 43 || code2 === 45 ? "listUnordered" : "listOrdered");
    if (kind === "listUnordered" ? !self.containerState.marker || code2 === self.containerState.marker : asciiDigit(code2)) {
      if (!self.containerState.type) {
        self.containerState.type = kind;
        effects.enter(kind, {
          _container: true
        });
      }
      if (kind === "listUnordered") {
        effects.enter("listItemPrefix");
        return code2 === 42 || code2 === 45 ? effects.check(thematicBreak, nok, atMarker)(code2) : atMarker(code2);
      }
      if (!self.interrupt || code2 === 49) {
        effects.enter("listItemPrefix");
        effects.enter("listItemValue");
        return inside(code2);
      }
    }
    return nok(code2);
  }
  function inside(code2) {
    if (asciiDigit(code2) && ++size < 10) {
      effects.consume(code2);
      return inside;
    }
    if ((!self.interrupt || size < 2) && (self.containerState.marker ? code2 === self.containerState.marker : code2 === 41 || code2 === 46)) {
      effects.exit("listItemValue");
      return atMarker(code2);
    }
    return nok(code2);
  }
  function atMarker(code2) {
    effects.enter("listItemMarker");
    effects.consume(code2);
    effects.exit("listItemMarker");
    self.containerState.marker = self.containerState.marker || code2;
    return effects.check(
      blankLine,
      // Can’t be empty when interrupting.
      self.interrupt ? nok : onBlank,
      effects.attempt(listItemPrefixWhitespaceConstruct, endOfPrefix, otherPrefix)
    );
  }
  function onBlank(code2) {
    self.containerState.initialBlankLine = true;
    initialSize++;
    return endOfPrefix(code2);
  }
  function otherPrefix(code2) {
    if (markdownSpace(code2)) {
      effects.enter("listItemPrefixWhitespace");
      effects.consume(code2);
      effects.exit("listItemPrefixWhitespace");
      return endOfPrefix;
    }
    return nok(code2);
  }
  function endOfPrefix(code2) {
    self.containerState.size = initialSize + self.sliceSerialize(effects.exit("listItemPrefix"), true).length;
    return ok3(code2);
  }
}
function tokenizeListContinuation(effects, ok3, nok) {
  const self = this;
  self.containerState._closeFlow = void 0;
  return effects.check(blankLine, onBlank, notBlank);
  function onBlank(code2) {
    self.containerState.furtherBlankLines = self.containerState.furtherBlankLines || self.containerState.initialBlankLine;
    return factorySpace(effects, ok3, "listItemIndent", self.containerState.size + 1)(code2);
  }
  function notBlank(code2) {
    if (self.containerState.furtherBlankLines || !markdownSpace(code2)) {
      self.containerState.furtherBlankLines = void 0;
      self.containerState.initialBlankLine = void 0;
      return notInCurrentItem(code2);
    }
    self.containerState.furtherBlankLines = void 0;
    self.containerState.initialBlankLine = void 0;
    return effects.attempt(indentConstruct, ok3, notInCurrentItem)(code2);
  }
  function notInCurrentItem(code2) {
    self.containerState._closeFlow = true;
    self.interrupt = void 0;
    return factorySpace(effects, effects.attempt(list, ok3, nok), "linePrefix", self.parser.constructs.disable.null.includes("codeIndented") ? void 0 : 4)(code2);
  }
}
function tokenizeIndent(effects, ok3, nok) {
  const self = this;
  return factorySpace(effects, afterPrefix, "listItemIndent", self.containerState.size + 1);
  function afterPrefix(code2) {
    const tail = self.events[self.events.length - 1];
    return tail && tail[1].type === "listItemIndent" && tail[2].sliceSerialize(tail[1], true).length === self.containerState.size ? ok3(code2) : nok(code2);
  }
}
function tokenizeListEnd(effects) {
  effects.exit(this.containerState.type);
}
function tokenizeListItemPrefixWhitespace(effects, ok3, nok) {
  const self = this;
  return factorySpace(effects, afterPrefix, "listItemPrefixWhitespace", self.parser.constructs.disable.null.includes("codeIndented") ? void 0 : 4 + 1);
  function afterPrefix(code2) {
    const tail = self.events[self.events.length - 1];
    return !markdownSpace(code2) && tail && tail[1].type === "listItemPrefixWhitespace" ? ok3(code2) : nok(code2);
  }
}

// node_modules/micromark-core-commonmark/lib/setext-underline.js
var setextUnderline = {
  name: "setextUnderline",
  resolveTo: resolveToSetextUnderline,
  tokenize: tokenizeSetextUnderline
};
function resolveToSetextUnderline(events, context) {
  const editMap = new EditMap();
  let index2 = events.length;
  let content4;
  let text4;
  let definition2;
  while (index2--) {
    if (events[index2][0] === "enter") {
      if (events[index2][1].type === "content") {
        content4 = index2;
        break;
      }
      if (events[index2][1].type === "paragraph") {
        text4 = index2;
      }
    } else {
      if (events[index2][1].type === "content") {
        editMap.add(index2, 1, []);
      }
      if (!definition2 && events[index2][1].type === "definition") {
        definition2 = index2;
      }
    }
  }
  const heading = {
    type: "setextHeading",
    start: {
      ...events[content4][1].start
    },
    end: {
      ...events[events.length - 1][1].end
    }
  };
  events[text4][1].type = "setextHeadingText";
  if (definition2) {
    editMap.add(text4, 0, [["enter", heading, context]]);
    editMap.add(definition2 + 1, 0, [["exit", events[content4][1], context]]);
    events[content4][1].end = {
      ...events[definition2][1].end
    };
  } else {
    events[content4][1] = heading;
  }
  editMap.add(events.length, 0, [["exit", heading, context]]);
  editMap.consume(events);
  return events;
}
function tokenizeSetextUnderline(effects, ok3, nok) {
  const self = this;
  let marker;
  return start2;
  function start2(code2) {
    let index2 = self.events.length;
    let paragraph;
    while (index2--) {
      if (self.events[index2][1].type !== "lineEnding" && self.events[index2][1].type !== "linePrefix" && self.events[index2][1].type !== "content") {
        paragraph = self.events[index2][1].type === "paragraph";
        break;
      }
    }
    if (!self.parser.lazy[self.now().line] && (self.interrupt || paragraph)) {
      effects.enter("setextHeadingLine");
      marker = code2;
      return before(code2);
    }
    return nok(code2);
  }
  function before(code2) {
    effects.enter("setextHeadingLineSequence");
    return inside(code2);
  }
  function inside(code2) {
    if (code2 === marker) {
      effects.consume(code2);
      return inside;
    }
    effects.exit("setextHeadingLineSequence");
    return markdownSpace(code2) ? factorySpace(effects, after, "lineSuffix")(code2) : after(code2);
  }
  function after(code2) {
    if (code2 === null || markdownLineEnding(code2)) {
      effects.exit("setextHeadingLine");
      return ok3(code2);
    }
    return nok(code2);
  }
}

// node_modules/micromark/lib/initialize/flow.js
var flow = {
  tokenize: initializeFlow
};
function initializeFlow(effects) {
  const self = this;
  const initial = effects.attempt(
    // Try to parse a blank line.
    blankLine,
    atBlankEnding,
    // Try to parse initial flow (essentially, only code).
    effects.attempt(this.parser.constructs.flowInitial, afterConstruct, factorySpace(effects, effects.attempt(this.parser.constructs.flow, afterConstruct, effects.attempt(content2, afterConstruct)), "linePrefix"))
  );
  return initial;
  function atBlankEnding(code2) {
    if (code2 === null) {
      effects.consume(code2);
      return;
    }
    effects.enter("lineEndingBlank");
    effects.consume(code2);
    effects.exit("lineEndingBlank");
    self.currentConstruct = void 0;
    return initial;
  }
  function afterConstruct(code2) {
    if (code2 === null) {
      effects.consume(code2);
      return;
    }
    effects.enter("lineEnding");
    effects.consume(code2);
    effects.exit("lineEnding");
    self.currentConstruct = void 0;
    return initial;
  }
}

// node_modules/micromark/lib/initialize/text.js
var resolver = {
  resolveAll: createResolver()
};
var string = initializeFactory("string");
var text = initializeFactory("text");
function initializeFactory(field) {
  return {
    resolveAll: createResolver(field === "text" ? resolveAllLineSuffixes : void 0),
    tokenize: initializeText
  };
  function initializeText(effects) {
    const self = this;
    const constructs2 = this.parser.constructs[field];
    const text4 = effects.attempt(constructs2, start2, notText);
    return start2;
    function start2(code2) {
      return atBreak(code2) ? text4(code2) : notText(code2);
    }
    function notText(code2) {
      if (code2 === null) {
        effects.consume(code2);
        return;
      }
      effects.enter("data");
      effects.consume(code2);
      return data;
    }
    function data(code2) {
      if (atBreak(code2)) {
        effects.exit("data");
        return text4(code2);
      }
      effects.consume(code2);
      return data;
    }
    function atBreak(code2) {
      if (code2 === null) {
        return true;
      }
      const list2 = constructs2[code2];
      let index2 = -1;
      if (list2) {
        while (++index2 < list2.length) {
          const item = list2[index2];
          if (!item.previous || item.previous.call(self, self.previous)) {
            return true;
          }
        }
      }
      return false;
    }
  }
}
function createResolver(extraResolver) {
  return resolveAllText;
  function resolveAllText(events, context) {
    let index2 = -1;
    let enter;
    while (++index2 <= events.length) {
      if (enter === void 0) {
        if (events[index2] && events[index2][1].type === "data") {
          enter = index2;
          index2++;
        }
      } else if (!events[index2] || events[index2][1].type !== "data") {
        if (index2 !== enter + 2) {
          events[enter][1].end = events[index2 - 1][1].end;
          events.splice(enter + 2, index2 - enter - 2);
          index2 = enter + 2;
        }
        enter = void 0;
      }
    }
    return extraResolver ? extraResolver(events, context) : events;
  }
}
function resolveAllLineSuffixes(events, context) {
  const editMap = new EditMap();
  let eventIndex = 0;
  while (++eventIndex <= events.length) {
    if ((eventIndex === events.length || events[eventIndex][1].type === "lineEnding") && events[eventIndex - 1][1].type === "data") {
      const data = events[eventIndex - 1][1];
      const chunks = context.sliceStream(data);
      let index2 = chunks.length;
      let bufferIndex = -1;
      let size = 0;
      let tabs;
      while (index2--) {
        const chunk = chunks[index2];
        if (typeof chunk === "string") {
          bufferIndex = chunk.length;
          while (chunk.charCodeAt(bufferIndex - 1) === 32) {
            size++;
            bufferIndex--;
          }
          if (bufferIndex) {
            break;
          }
          bufferIndex = -1;
        } else if (chunk === -2) {
          tabs = true;
          size++;
        } else if (chunk === -1) {
        } else {
          index2++;
          break;
        }
      }
      if (context._contentTypeTextTrailing && eventIndex === events.length) {
        size = 0;
      }
      if (size) {
        const token = {
          type: eventIndex === events.length || tabs || size < 2 ? "lineSuffix" : "hardBreakTrailing",
          start: {
            _bufferIndex: index2 ? bufferIndex : data.start._bufferIndex + bufferIndex,
            _index: data.start._index + index2,
            line: data.end.line,
            column: data.end.column - size,
            offset: data.end.offset - size
          },
          end: {
            ...data.end
          }
        };
        data.end = {
          ...token.start
        };
        if (data.start.offset === data.end.offset) {
          Object.assign(data, token);
        } else {
          editMap.add(eventIndex, 0, [["enter", token, context], ["exit", token, context]]);
        }
      }
      eventIndex++;
    }
  }
  editMap.consume(events);
  return events;
}

// node_modules/micromark/lib/constructs.js
var constructs_exports = {};
__export(constructs_exports, {
  attentionMarkers: () => attentionMarkers,
  contentInitial: () => contentInitial,
  disable: () => disable,
  document: () => document2,
  flow: () => flow2,
  flowInitial: () => flowInitial,
  insideSpan: () => insideSpan,
  string: () => string2,
  text: () => text2
});
var document2 = {
  [42]: list,
  [43]: list,
  [45]: list,
  [48]: list,
  [49]: list,
  [50]: list,
  [51]: list,
  [52]: list,
  [53]: list,
  [54]: list,
  [55]: list,
  [56]: list,
  [57]: list,
  [62]: blockQuote
};
var contentInitial = {
  [91]: definition
};
var flowInitial = {
  [-2]: codeIndented,
  [-1]: codeIndented,
  [32]: codeIndented
};
var flow2 = {
  [35]: headingAtx,
  [42]: thematicBreak,
  [45]: [setextUnderline, thematicBreak],
  [60]: htmlFlow,
  [61]: setextUnderline,
  [95]: thematicBreak,
  [96]: codeFenced,
  [126]: codeFenced
};
var string2 = {
  [38]: characterReference,
  [92]: characterEscape
};
var text2 = {
  [-5]: lineEnding,
  [-4]: lineEnding,
  [-3]: lineEnding,
  [33]: labelStartImage,
  [38]: characterReference,
  [42]: attention,
  [60]: [autolink, htmlText],
  [91]: labelStartLink,
  [92]: [hardBreakEscape, characterEscape],
  [93]: labelEnd,
  [95]: attention,
  [96]: codeText
};
var insideSpan = {
  null: [attention, resolver]
};
var attentionMarkers = {
  null: [42, 95]
};
var disable = {
  null: []
};

// node_modules/micromark/lib/create-tokenizer.js
function createTokenizer(parser, initialize, from) {
  let point3 = {
    _bufferIndex: -1,
    _index: 0,
    line: from && from.line || 1,
    column: from && from.column || 1,
    offset: from && from.offset || 0
  };
  const columnStart = {};
  const resolveAllConstructs = [];
  let chunks = [];
  let stack = [];
  let consumed = true;
  const effects = {
    attempt: constructFactory(onsuccessfulconstruct),
    check: constructFactory(onsuccessfulcheck),
    consume,
    enter,
    exit: exit3,
    interrupt: constructFactory(onsuccessfulcheck, {
      interrupt: true
    })
  };
  const context = {
    code: null,
    containerState: {},
    defineSkip,
    events: [],
    now,
    parser,
    previous: null,
    sliceSerialize,
    sliceStream,
    write
  };
  let state = initialize.tokenize.call(context, effects);
  let expectedCode;
  if (initialize.resolveAll) {
    resolveAllConstructs.push(initialize);
  }
  return context;
  function write(slice) {
    chunks = push(chunks, slice);
    main2();
    if (chunks[chunks.length - 1] !== null) {
      return [];
    }
    addResult(initialize, 0);
    context.events = resolveAll(resolveAllConstructs, context.events, context);
    return context.events;
  }
  function sliceSerialize(token, expandTabs) {
    return serializeChunks(sliceStream(token), expandTabs);
  }
  function sliceStream(token) {
    return sliceChunks(chunks, token);
  }
  function now() {
    const {
      _bufferIndex,
      _index,
      line: line2,
      column,
      offset
    } = point3;
    return {
      _bufferIndex,
      _index,
      line: line2,
      column,
      offset
    };
  }
  function defineSkip(value) {
    columnStart[value.line] = value.column;
    accountForPotentialSkip();
  }
  function main2() {
    while (point3._index < chunks.length) {
      const chunk = chunks[point3._index];
      if (typeof chunk === "string") {
        const chunkIndex = point3._index;
        if (point3._bufferIndex < 0) {
          point3._bufferIndex = 0;
        }
        while (point3._index === chunkIndex && point3._bufferIndex < chunk.length) {
          go(chunk.charCodeAt(point3._bufferIndex));
        }
      } else {
        go(chunk);
      }
    }
  }
  function go(code2) {
    consumed = void 0;
    expectedCode = code2;
    state = state(code2);
  }
  function consume(code2) {
    if (markdownLineEnding(code2)) {
      point3.line++;
      point3.column = 1;
      point3.offset += code2 === -3 ? 2 : 1;
      accountForPotentialSkip();
    } else if (code2 !== -1) {
      point3.column++;
      point3.offset++;
    }
    if (point3._bufferIndex < 0) {
      point3._index++;
    } else {
      point3._bufferIndex++;
      if (point3._bufferIndex === // Points w/ non-negative `_bufferIndex` reference
      // strings.
      /** @type {string} */
      chunks[point3._index].length) {
        point3._bufferIndex = -1;
        point3._index++;
      }
    }
    context.previous = code2;
    consumed = true;
  }
  function enter(type, fields) {
    const token = fields || {};
    token.type = type;
    token.start = now();
    context.events.push(["enter", token, context]);
    stack.push(token);
    return token;
  }
  function exit3(type) {
    const token = stack.pop();
    token.end = now();
    context.events.push(["exit", token, context]);
    return token;
  }
  function onsuccessfulconstruct(construct, info) {
    addResult(construct, info.from);
  }
  function onsuccessfulcheck(_, info) {
    info.restore();
  }
  function constructFactory(onreturn, fields) {
    return hook;
    function hook(constructs2, returnState, bogusState) {
      let listOfConstructs;
      let constructIndex;
      let currentConstruct;
      let info;
      return Array.isArray(constructs2) ? (
        /* c8 ignore next 1 */
        handleListOfConstructs(constructs2)
      ) : "tokenize" in constructs2 ? (
        // Looks like a construct.
        handleListOfConstructs([
          /** @type {Construct} */
          constructs2
        ])
      ) : handleMapOfConstructs(constructs2);
      function handleMapOfConstructs(map) {
        return start2;
        function start2(code2) {
          const left = code2 !== null && map[code2];
          const all2 = code2 !== null && map.null;
          const list2 = [
            // To do: add more extension tests.
            /* c8 ignore next 2 */
            ...Array.isArray(left) ? left : left ? [left] : [],
            ...Array.isArray(all2) ? all2 : all2 ? [all2] : []
          ];
          return handleListOfConstructs(list2)(code2);
        }
      }
      function handleListOfConstructs(list2) {
        listOfConstructs = list2;
        constructIndex = 0;
        if (list2.length === 0) {
          return bogusState;
        }
        return handleConstruct(list2[constructIndex]);
      }
      function handleConstruct(construct) {
        return start2;
        function start2(code2) {
          info = store();
          currentConstruct = construct;
          if (!construct.partial) {
            context.currentConstruct = construct;
          }
          if (construct.name && context.parser.constructs.disable.null.includes(construct.name)) {
            return nok(code2);
          }
          return construct.tokenize.call(
            // If we do have fields, create an object w/ `context` as its
            // prototype.
            // This allows a “live binding”, which is needed for `interrupt`.
            fields ? Object.assign(Object.create(context), fields) : context,
            effects,
            ok3,
            nok
          )(code2);
        }
      }
      function ok3(code2) {
        consumed = true;
        onreturn(currentConstruct, info);
        return returnState;
      }
      function nok(code2) {
        consumed = true;
        info.restore();
        if (++constructIndex < listOfConstructs.length) {
          return handleConstruct(listOfConstructs[constructIndex]);
        }
        return bogusState;
      }
    }
  }
  function addResult(construct, from2) {
    if (construct.resolveAll && !resolveAllConstructs.includes(construct)) {
      resolveAllConstructs.push(construct);
    }
    if (construct.resolve) {
      splice(context.events, from2, context.events.length - from2, construct.resolve(context.events.slice(from2), context));
    }
    if (construct.resolveTo) {
      context.events = construct.resolveTo(context.events, context);
    }
  }
  function store() {
    const startPoint = now();
    const startPrevious = context.previous;
    const startCurrentConstruct = context.currentConstruct;
    const startEventsIndex = context.events.length;
    const startStack = Array.from(stack);
    return {
      from: startEventsIndex,
      restore
    };
    function restore() {
      point3 = startPoint;
      context.previous = startPrevious;
      context.currentConstruct = startCurrentConstruct;
      context.events.length = startEventsIndex;
      stack = startStack;
      accountForPotentialSkip();
    }
  }
  function accountForPotentialSkip() {
    if (point3.line in columnStart && point3.column < 2) {
      point3.column = columnStart[point3.line];
      point3.offset += columnStart[point3.line] - 1;
    }
  }
}
function sliceChunks(chunks, token) {
  const startIndex = token.start._index;
  const startBufferIndex = token.start._bufferIndex;
  const endIndex = token.end._index;
  const endBufferIndex = token.end._bufferIndex;
  let view;
  if (startIndex === endIndex) {
    view = [chunks[startIndex].slice(startBufferIndex, endBufferIndex)];
  } else {
    view = chunks.slice(startIndex, endIndex);
    if (startBufferIndex > -1) {
      const head = view[0];
      if (typeof head === "string") {
        view[0] = head.slice(startBufferIndex);
      } else {
        view.shift();
      }
    }
    if (endBufferIndex > 0) {
      view.push(chunks[endIndex].slice(0, endBufferIndex));
    }
  }
  return view;
}
function serializeChunks(chunks, expandTabs) {
  let index2 = -1;
  const result = [];
  let atTab;
  while (++index2 < chunks.length) {
    const chunk = chunks[index2];
    let value;
    if (typeof chunk === "string") {
      value = chunk;
    } else {
      switch (chunk) {
        case -5: {
          value = "\r";
          break;
        }
        case -4: {
          value = "\n";
          break;
        }
        case -3: {
          value = "\r\n";
          break;
        }
        case -2: {
          value = expandTabs ? " " : "	";
          break;
        }
        case -1: {
          if (!expandTabs && atTab) {
            continue;
          }
          value = " ";
          break;
        }
        default: {
          value = String.fromCharCode(chunk);
        }
      }
    }
    atTab = chunk === -2;
    result.push(value);
  }
  return result.join("");
}

// node_modules/micromark/lib/parse.js
function parse(options) {
  const settings = options || {};
  const constructs2 = (
    /** @type {FullNormalizedExtension} */
    combineExtensions([constructs_exports, ...settings.extensions || []])
  );
  const parser = {
    constructs: constructs2,
    content: create(content),
    defined: [],
    document: create(document),
    flow: create(flow),
    lazy: {},
    string: create(string),
    text: create(text)
  };
  return parser;
  function create(initial) {
    return creator;
    function creator(from) {
      return createTokenizer(parser, initial, from);
    }
  }
}

// node_modules/micromark/lib/postprocess.js
function postprocess(events) {
  while (!subtokenize(events)) {
  }
  return events;
}

// node_modules/micromark/lib/preprocess.js
var search = /[\0\t\n\r]/g;
function preprocess() {
  let column = 1;
  let buffer = "";
  let start2 = true;
  let atCarriageReturn;
  return preprocessor;
  function preprocessor(value, encoding, end2) {
    value = buffer + (typeof value === "string" ? value.toString() : new TextDecoder(encoding || void 0).decode(value));
    const chunks = [];
    let startPosition = 0;
    buffer = "";
    if (start2) {
      if (value.charCodeAt(0) === 65279) {
        startPosition++;
      }
      start2 = void 0;
    }
    while (startPosition < value.length) {
      search.lastIndex = startPosition;
      const match = search.exec(value);
      const endPosition = match && match.index !== void 0 ? match.index : value.length;
      const code2 = value.charCodeAt(endPosition);
      if (!match) {
        buffer = value.slice(startPosition);
        break;
      }
      if (code2 === 10 && startPosition === endPosition && atCarriageReturn) {
        chunks.push(-3);
        atCarriageReturn = void 0;
      } else {
        if (atCarriageReturn) {
          chunks.push(-5);
          atCarriageReturn = void 0;
        }
        if (startPosition < endPosition) {
          chunks.push(value.slice(startPosition, endPosition));
          column += endPosition - startPosition;
        }
        switch (code2) {
          case 0: {
            chunks.push(65533);
            column++;
            break;
          }
          case 9: {
            const next = Math.ceil(column / 4) * 4;
            chunks.push(-2);
            while (column++ < next) {
              chunks.push(-1);
            }
            break;
          }
          case 10: {
            chunks.push(-4);
            column = 1;
            break;
          }
          default: {
            atCarriageReturn = true;
            column = 1;
          }
        }
      }
      startPosition = endPosition + 1;
    }
    if (end2) {
      if (atCarriageReturn) {
        chunks.push(-5);
      }
      if (buffer) {
        chunks.push(buffer);
      }
      chunks.push(null);
    }
    return chunks;
  }
}

// node_modules/micromark-util-decode-string/index.js
var characterEscapeOrReference = /\\([!-/:-@[-`{-~])|&(#(?:\d{1,7}|x[\da-f]{1,6})|[\da-z]{1,31});/gi;
function decodeString(value) {
  return value.replace(characterEscapeOrReference, decode);
}
function decode($0, $1, $2) {
  if ($1) {
    return $1;
  }
  const head = $2.charCodeAt(0);
  if (head === 35) {
    const head2 = $2.charCodeAt(1);
    const hex = head2 === 120 || head2 === 88;
    return decodeNumericCharacterReference($2.slice(hex ? 2 : 1), hex ? 16 : 10);
  }
  return decodeNamedCharacterReference($2) || $0;
}

// node_modules/unist-util-stringify-position/lib/index.js
function stringifyPosition(value) {
  if (!value || typeof value !== "object") {
    return "";
  }
  if ("position" in value || "type" in value) {
    return position(value.position);
  }
  if ("start" in value || "end" in value) {
    return position(value);
  }
  if ("line" in value || "column" in value) {
    return point(value);
  }
  return "";
}
function point(point3) {
  return index(point3 && point3.line) + ":" + index(point3 && point3.column);
}
function position(pos) {
  return point(pos && pos.start) + "-" + point(pos && pos.end);
}
function index(value) {
  return value && typeof value === "number" ? value : 1;
}

// node_modules/mdast-util-from-markdown/lib/index.js
var own2 = {}.hasOwnProperty;
function fromMarkdown(value, encoding, options) {
  if (encoding && typeof encoding === "object") {
    options = encoding;
    encoding = void 0;
  }
  return compiler(options)(postprocess(parse(options).document().write(preprocess()(value, encoding, true))));
}
function compiler(options) {
  const config = {
    afterExit: [],
    beforeEnter: [],
    transforms: [],
    canContainEols: ["emphasis", "fragment", "heading", "paragraph", "strong"],
    enter: {
      autolink: opener(link),
      autolinkProtocol: onenterdata,
      autolinkEmail: onenterdata,
      atxHeading: opener(heading),
      blockQuote: opener(blockQuote2),
      characterEscape: onenterdata,
      characterReference: onenterdata,
      codeFenced: opener(codeFlow),
      codeFencedFenceInfo: buffer,
      codeFencedFenceMeta: buffer,
      codeIndented: opener(codeFlow, buffer),
      codeText: opener(codeText2, buffer),
      codeTextData: onenterdata,
      data: onenterdata,
      codeFlowValue: onenterdata,
      definition: opener(definition2),
      definitionDestinationString: buffer,
      definitionLabelString: buffer,
      definitionTitleString: buffer,
      emphasis: opener(emphasis),
      hardBreakEscape: opener(hardBreak),
      hardBreakTrailing: opener(hardBreak),
      htmlFlow: opener(html, buffer),
      htmlFlowData: onenterdata,
      htmlText: opener(html, buffer),
      htmlTextData: onenterdata,
      image: opener(image),
      label: buffer,
      link: opener(link),
      listItem: opener(listItem),
      listItemValue: onenterlistitemvalue,
      listOrdered: opener(list2, onenterlistordered),
      listUnordered: opener(list2),
      paragraph: opener(paragraph),
      reference: onenterreference,
      referenceString: buffer,
      resourceDestinationString: buffer,
      resourceTitleString: buffer,
      setextHeading: opener(heading),
      strong: opener(strong),
      thematicBreak: opener(thematicBreak2)
    },
    exit: {
      atxHeading: closer(),
      atxHeadingSequence: onexitatxheadingsequence,
      autolink: closer(),
      autolinkEmail: onexitautolinkemail,
      autolinkProtocol: onexitautolinkprotocol,
      blockQuote: closer(),
      characterEscapeValue: onexitdata,
      characterReferenceMarkerHexadecimal: onexitcharacterreferencemarker,
      characterReferenceMarkerNumeric: onexitcharacterreferencemarker,
      characterReferenceValue: onexitcharacterreferencevalue,
      characterReference: onexitcharacterreference,
      codeFenced: closer(onexitcodefenced),
      codeFencedFence: onexitcodefencedfence,
      codeFencedFenceInfo: onexitcodefencedfenceinfo,
      codeFencedFenceMeta: onexitcodefencedfencemeta,
      codeFlowValue: onexitdata,
      codeIndented: closer(onexitcodeindented),
      codeText: closer(onexitcodetext),
      codeTextData: onexitdata,
      data: onexitdata,
      definition: closer(),
      definitionDestinationString: onexitdefinitiondestinationstring,
      definitionLabelString: onexitdefinitionlabelstring,
      definitionTitleString: onexitdefinitiontitlestring,
      emphasis: closer(),
      hardBreakEscape: closer(onexithardbreak),
      hardBreakTrailing: closer(onexithardbreak),
      htmlFlow: closer(onexithtmlflow),
      htmlFlowData: onexitdata,
      htmlText: closer(onexithtmltext),
      htmlTextData: onexitdata,
      image: closer(onexitimage),
      label: onexitlabel,
      labelText: onexitlabeltext,
      lineEnding: onexitlineending,
      link: closer(onexitlink),
      listItem: closer(),
      listOrdered: closer(),
      listUnordered: closer(),
      paragraph: closer(),
      referenceString: onexitreferencestring,
      resourceDestinationString: onexitresourcedestinationstring,
      resourceTitleString: onexitresourcetitlestring,
      resource: onexitresource,
      setextHeading: closer(onexitsetextheading),
      setextHeadingLineSequence: onexitsetextheadinglinesequence,
      setextHeadingText: onexitsetextheadingtext,
      strong: closer(),
      thematicBreak: closer()
    }
  };
  configure(config, (options || {}).mdastExtensions || []);
  const data = {};
  return compile;
  function compile(events) {
    let tree = {
      type: "root",
      children: [],
      position: void 0
    };
    const context = {
      stack: [tree],
      tokenStack: [],
      config,
      enter,
      exit: exit3,
      buffer,
      resume,
      data
    };
    const listStack = [];
    const prepared = [];
    let index2 = -1;
    while (++index2 < events.length) {
      prepared.push(events[index2]);
      if (events[index2][1].type === "listOrdered" || events[index2][1].type === "listUnordered") {
        if (events[index2][0] === "enter") {
          listStack.push(prepared.length - 1);
        } else {
          const tail = listStack.pop();
          prepareList(prepared, tail);
        }
      }
    }
    events = prepared;
    index2 = -1;
    while (++index2 < events.length) {
      const handler = config[events[index2][0]];
      if (events[index2][0] === "enter" && config.beforeEnter.length > 0) {
        callListeners(config.beforeEnter, {
          ...context,
          sliceSerialize: events[index2][2].sliceSerialize
        }, events[index2][1]);
      }
      if (own2.call(handler, events[index2][1].type)) {
        handler[events[index2][1].type].call({
          ...context,
          sliceSerialize: events[index2][2].sliceSerialize
        }, events[index2][1]);
      }
      if (events[index2][0] === "exit" && config.afterExit.length > 0) {
        callListeners(config.afterExit, {
          ...context,
          sliceSerialize: events[index2][2].sliceSerialize
        }, events[index2][1]);
      }
    }
    if (context.tokenStack.length > 0) {
      const tail = context.tokenStack[context.tokenStack.length - 1];
      const handler = tail[1] || defaultOnError;
      handler.call(context, void 0, tail[0]);
    }
    tree.position = {
      start: point2(events.length > 0 ? events[0][1].start : {
        line: 1,
        column: 1,
        offset: 0
      }),
      end: point2(events.length > 0 ? events[events.length - 2][1].end : {
        line: 1,
        column: 1,
        offset: 0
      })
    };
    index2 = -1;
    while (++index2 < config.transforms.length) {
      tree = config.transforms[index2](tree) || tree;
    }
    return tree;
  }
  function callListeners(listeners, context, token) {
    let index2 = -1;
    while (++index2 < listeners.length) {
      listeners[index2].call(context, token);
    }
  }
  function prepareList(events, start2) {
    const end2 = events.length - 1;
    let index2 = start2 - 1;
    let containerBalance = -1;
    let listSpread = false;
    let listItem2;
    let lineIndex;
    let firstBlankLineIndex;
    let atMarker;
    const insertions = [];
    while (++index2 <= end2) {
      const event = events[index2];
      switch (event[1].type) {
        case "listUnordered":
        case "listOrdered":
        case "blockQuote": {
          if (event[0] === "enter") {
            containerBalance++;
          } else {
            containerBalance--;
          }
          atMarker = void 0;
          break;
        }
        case "lineEndingBlank": {
          if (event[0] === "enter") {
            if (listItem2 && !atMarker && !containerBalance && !firstBlankLineIndex) {
              firstBlankLineIndex = index2;
            }
            atMarker = void 0;
          }
          break;
        }
        case "linePrefix":
        case "listItemValue":
        case "listItemMarker":
        case "listItemPrefix":
        case "listItemPrefixWhitespace": {
          break;
        }
        default: {
          atMarker = void 0;
        }
      }
      if (!containerBalance && event[0] === "enter" && event[1].type === "listItemPrefix" || containerBalance === -1 && event[0] === "exit" && (event[1].type === "listUnordered" || event[1].type === "listOrdered")) {
        if (listItem2) {
          let tailIndex = index2;
          lineIndex = void 0;
          while (tailIndex--) {
            const tailEvent = events[tailIndex];
            if (tailEvent[1].type === "lineEnding" || tailEvent[1].type === "lineEndingBlank") {
              if (tailEvent[0] === "exit") continue;
              if (lineIndex) {
                events[lineIndex][1].type = "lineEndingBlank";
                listSpread = true;
              }
              tailEvent[1].type = "lineEnding";
              lineIndex = tailIndex;
            } else if (tailEvent[1].type === "linePrefix" || tailEvent[1].type === "blockQuotePrefix" || tailEvent[1].type === "blockQuotePrefixWhitespace" || tailEvent[1].type === "blockQuoteMarker" || tailEvent[1].type === "listItemIndent") {
            } else {
              break;
            }
          }
          if (firstBlankLineIndex && (!lineIndex || firstBlankLineIndex < lineIndex)) {
            listItem2._spread = true;
          }
          listItem2.end = Object.assign({}, lineIndex ? events[lineIndex][1].start : event[1].end);
          insertions.push({
            at: lineIndex || index2,
            event: ["exit", listItem2, event[2]]
          });
        }
        if (event[1].type === "listItemPrefix") {
          const item = {
            type: "listItem",
            _spread: false,
            start: Object.assign({}, event[1].start),
            // @ts-expect-error: we’ll add `end` in a second.
            end: void 0
          };
          listItem2 = item;
          insertions.push({
            at: index2,
            event: ["enter", item, event[2]]
          });
          firstBlankLineIndex = void 0;
          atMarker = true;
        }
      }
    }
    const listEvents = events.splice(start2);
    let insertion = 0;
    index2 = -1;
    while (++index2 < listEvents.length) {
      while (insertion < insertions.length && insertions[insertion].at === start2 + index2) {
        events.push(insertions[insertion++].event);
      }
      events.push(listEvents[index2]);
    }
    events[start2][1]._spread = listSpread;
  }
  function opener(create, and) {
    return open;
    function open(token) {
      enter.call(this, create(token), token);
      if (and) and.call(this, token);
    }
  }
  function buffer() {
    this.stack.push({
      type: "fragment",
      children: []
    });
  }
  function enter(node2, token, errorHandler) {
    const parent = this.stack[this.stack.length - 1];
    const siblings = parent.children;
    siblings.push(node2);
    this.stack.push(node2);
    this.tokenStack.push([token, errorHandler || void 0]);
    node2.position = {
      start: point2(token.start),
      // @ts-expect-error: `end` will be patched later.
      end: void 0
    };
  }
  function closer(and) {
    return close;
    function close(token) {
      if (and) and.call(this, token);
      exit3.call(this, token);
    }
  }
  function exit3(token, onExitError) {
    const node2 = this.stack.pop();
    const open = this.tokenStack.pop();
    if (!open) {
      throw new Error("Cannot close `" + token.type + "` (" + stringifyPosition({
        start: token.start,
        end: token.end
      }) + "): it\u2019s not open");
    }
    if (open[0].type !== token.type) {
      if (onExitError) {
        onExitError.call(this, token, open[0]);
      } else {
        const handler = open[1] || defaultOnError;
        handler.call(this, token, open[0]);
      }
    }
    node2.position.end = point2(token.end);
  }
  function resume() {
    return toString(this.stack.pop());
  }
  function onenterlistordered() {
    this.data.expectingFirstListItemValue = true;
  }
  function onenterlistitemvalue(token) {
    if (this.data.expectingFirstListItemValue) {
      const ancestor = this.stack[this.stack.length - 2];
      ancestor.start = Number.parseInt(this.sliceSerialize(token), 10);
      this.data.expectingFirstListItemValue = void 0;
    }
  }
  function onexitcodefencedfenceinfo() {
    const data2 = this.resume();
    const node2 = this.stack[this.stack.length - 1];
    node2.lang = data2;
  }
  function onexitcodefencedfencemeta() {
    const data2 = this.resume();
    const node2 = this.stack[this.stack.length - 1];
    node2.meta = data2;
  }
  function onexitcodefencedfence() {
    if (this.data.flowCodeInside) return;
    this.buffer();
    this.data.flowCodeInside = true;
  }
  function onexitcodefenced() {
    const data2 = this.resume();
    const node2 = this.stack[this.stack.length - 1];
    node2.value = data2.replace(/^(\r?\n|\r)|(\r?\n|\r)$/g, "");
    this.data.flowCodeInside = void 0;
  }
  function onexitcodeindented() {
    const data2 = this.resume();
    const node2 = this.stack[this.stack.length - 1];
    node2.value = data2.replace(/(\r?\n|\r)$/g, "");
  }
  function onexitdefinitionlabelstring(token) {
    const label = this.resume();
    const node2 = this.stack[this.stack.length - 1];
    node2.label = label;
    node2.identifier = normalizeIdentifier(this.sliceSerialize(token)).toLowerCase();
  }
  function onexitdefinitiontitlestring() {
    const data2 = this.resume();
    const node2 = this.stack[this.stack.length - 1];
    node2.title = data2;
  }
  function onexitdefinitiondestinationstring() {
    const data2 = this.resume();
    const node2 = this.stack[this.stack.length - 1];
    node2.url = data2;
  }
  function onexitatxheadingsequence(token) {
    const node2 = this.stack[this.stack.length - 1];
    if (!node2.depth) {
      const depth2 = this.sliceSerialize(token).length;
      node2.depth = depth2;
    }
  }
  function onexitsetextheadingtext() {
    this.data.setextHeadingSlurpLineEnding = true;
  }
  function onexitsetextheadinglinesequence(token) {
    const node2 = this.stack[this.stack.length - 1];
    node2.depth = this.sliceSerialize(token).codePointAt(0) === 61 ? 1 : 2;
  }
  function onexitsetextheading() {
    this.data.setextHeadingSlurpLineEnding = void 0;
  }
  function onenterdata(token) {
    const node2 = this.stack[this.stack.length - 1];
    const siblings = node2.children;
    let tail = siblings[siblings.length - 1];
    if (!tail || tail.type !== "text") {
      tail = text4();
      tail.position = {
        start: point2(token.start),
        // @ts-expect-error: we’ll add `end` later.
        end: void 0
      };
      siblings.push(tail);
    }
    this.stack.push(tail);
  }
  function onexitdata(token) {
    const tail = this.stack.pop();
    tail.value += this.sliceSerialize(token);
    tail.position.end = point2(token.end);
  }
  function onexitlineending(token) {
    const context = this.stack[this.stack.length - 1];
    if (this.data.atHardBreak) {
      const tail = context.children[context.children.length - 1];
      tail.position.end = point2(token.end);
      this.data.atHardBreak = void 0;
      return;
    }
    if (!this.data.setextHeadingSlurpLineEnding && config.canContainEols.includes(context.type)) {
      onenterdata.call(this, token);
      onexitdata.call(this, token);
    }
  }
  function onexithardbreak() {
    this.data.atHardBreak = true;
  }
  function onexithtmlflow() {
    const data2 = this.resume();
    const node2 = this.stack[this.stack.length - 1];
    node2.value = data2;
  }
  function onexithtmltext() {
    const data2 = this.resume();
    const node2 = this.stack[this.stack.length - 1];
    node2.value = data2;
  }
  function onexitcodetext() {
    const data2 = this.resume();
    const node2 = this.stack[this.stack.length - 1];
    node2.value = data2;
  }
  function onexitlink() {
    const node2 = this.stack[this.stack.length - 1];
    if (this.data.inReference) {
      const referenceType = this.data.referenceType || "shortcut";
      node2.type += "Reference";
      node2.referenceType = referenceType;
      delete node2.url;
      delete node2.title;
    } else {
      delete node2.identifier;
      delete node2.label;
    }
    this.data.referenceType = void 0;
  }
  function onexitimage() {
    const node2 = this.stack[this.stack.length - 1];
    if (this.data.inReference) {
      const referenceType = this.data.referenceType || "shortcut";
      node2.type += "Reference";
      node2.referenceType = referenceType;
      delete node2.url;
      delete node2.title;
    } else {
      delete node2.identifier;
      delete node2.label;
    }
    this.data.referenceType = void 0;
  }
  function onexitlabeltext(token) {
    const string3 = this.sliceSerialize(token);
    const ancestor = this.stack[this.stack.length - 2];
    ancestor.label = decodeString(string3);
    ancestor.identifier = normalizeIdentifier(string3).toLowerCase();
  }
  function onexitlabel() {
    const fragment = this.stack[this.stack.length - 1];
    const value = this.resume();
    const node2 = this.stack[this.stack.length - 1];
    this.data.inReference = true;
    if (node2.type === "link") {
      const children = fragment.children;
      node2.children = children;
    } else {
      node2.alt = value;
    }
  }
  function onexitresourcedestinationstring() {
    const data2 = this.resume();
    const node2 = this.stack[this.stack.length - 1];
    node2.url = data2;
  }
  function onexitresourcetitlestring() {
    const data2 = this.resume();
    const node2 = this.stack[this.stack.length - 1];
    node2.title = data2;
  }
  function onexitresource() {
    this.data.inReference = void 0;
  }
  function onenterreference() {
    this.data.referenceType = "collapsed";
  }
  function onexitreferencestring(token) {
    const label = this.resume();
    const node2 = this.stack[this.stack.length - 1];
    node2.label = label;
    node2.identifier = normalizeIdentifier(this.sliceSerialize(token)).toLowerCase();
    this.data.referenceType = "full";
  }
  function onexitcharacterreferencemarker(token) {
    this.data.characterReferenceType = token.type;
  }
  function onexitcharacterreferencevalue(token) {
    const data2 = this.sliceSerialize(token);
    const type = this.data.characterReferenceType;
    let value;
    if (type) {
      value = decodeNumericCharacterReference(data2, type === "characterReferenceMarkerNumeric" ? 10 : 16);
      this.data.characterReferenceType = void 0;
    } else {
      const result = decodeNamedCharacterReference(data2);
      value = result;
    }
    const tail = this.stack[this.stack.length - 1];
    tail.value += value;
  }
  function onexitcharacterreference(token) {
    const tail = this.stack.pop();
    tail.position.end = point2(token.end);
  }
  function onexitautolinkprotocol(token) {
    onexitdata.call(this, token);
    const node2 = this.stack[this.stack.length - 1];
    node2.url = this.sliceSerialize(token);
  }
  function onexitautolinkemail(token) {
    onexitdata.call(this, token);
    const node2 = this.stack[this.stack.length - 1];
    node2.url = "mailto:" + this.sliceSerialize(token);
  }
  function blockQuote2() {
    return {
      type: "blockquote",
      children: [],
      position: void 0
    };
  }
  function codeFlow() {
    return {
      type: "code",
      lang: null,
      meta: null,
      value: "",
      position: void 0
    };
  }
  function codeText2() {
    return {
      type: "inlineCode",
      value: "",
      position: void 0
    };
  }
  function definition2() {
    return {
      type: "definition",
      identifier: "",
      label: null,
      title: null,
      url: "",
      position: void 0
    };
  }
  function emphasis() {
    return {
      type: "emphasis",
      children: [],
      position: void 0
    };
  }
  function heading() {
    return {
      type: "heading",
      // @ts-expect-error `depth` will be set later.
      depth: 0,
      children: [],
      position: void 0
    };
  }
  function hardBreak() {
    return {
      type: "break",
      position: void 0
    };
  }
  function html() {
    return {
      type: "html",
      value: "",
      position: void 0
    };
  }
  function image() {
    return {
      type: "image",
      title: null,
      url: "",
      alt: null,
      position: void 0
    };
  }
  function link() {
    return {
      type: "link",
      title: null,
      url: "",
      children: [],
      position: void 0
    };
  }
  function list2(token) {
    return {
      type: "list",
      ordered: token.type === "listOrdered",
      start: null,
      spread: token._spread,
      children: [],
      position: void 0
    };
  }
  function listItem(token) {
    return {
      type: "listItem",
      spread: token._spread,
      checked: null,
      children: [],
      position: void 0
    };
  }
  function paragraph() {
    return {
      type: "paragraph",
      children: [],
      position: void 0
    };
  }
  function strong() {
    return {
      type: "strong",
      children: [],
      position: void 0
    };
  }
  function text4() {
    return {
      type: "text",
      value: "",
      position: void 0
    };
  }
  function thematicBreak2() {
    return {
      type: "thematicBreak",
      position: void 0
    };
  }
}
function point2(d) {
  return {
    line: d.line,
    column: d.column,
    offset: d.offset
  };
}
function configure(combined, extensions) {
  let index2 = -1;
  while (++index2 < extensions.length) {
    const value = extensions[index2];
    if (Array.isArray(value)) {
      configure(combined, value);
    } else {
      extension(combined, value);
    }
  }
}
function extension(combined, extension2) {
  let key;
  for (key in extension2) {
    if (own2.call(extension2, key)) {
      switch (key) {
        case "canContainEols": {
          const right = extension2[key];
          if (right) {
            combined[key].push(...right);
          }
          break;
        }
        case "transforms": {
          const right = extension2[key];
          if (right) {
            combined[key].push(...right);
          }
          break;
        }
        case "afterExit":
        case "beforeEnter": {
          const right = extension2[key];
          if (right) {
            combined[key].push(right);
          }
          break;
        }
        case "enter":
        case "exit": {
          const right = extension2[key];
          if (right) {
            Object.assign(combined[key], right);
          }
          break;
        }
      }
    }
  }
}
function defaultOnError(left, right) {
  if (left) {
    throw new Error("Cannot close `" + left.type + "` (" + stringifyPosition({
      start: left.start,
      end: left.end
    }) + "): a different token (`" + right.type + "`, " + stringifyPosition({
      start: right.start,
      end: right.end
    }) + ") is open");
  }
  throw new Error("Cannot close document, a token (`" + right.type + "`, " + stringifyPosition({
    start: right.start,
    end: right.end
  }) + ") is still open");
}

// node_modules/ccount/index.js
function ccount(value, character) {
  const source = String(value);
  if (typeof character !== "string") {
    throw new TypeError("Expected character");
  }
  let count4 = 0;
  let index2 = source.indexOf(character);
  while (index2 !== -1) {
    count4++;
    index2 = source.indexOf(character, index2 + character.length);
  }
  return count4;
}

// node_modules/devlop/lib/default.js
function ok() {
}

// node_modules/escape-string-regexp/index.js
function escapeStringRegexp(string3) {
  if (typeof string3 !== "string") {
    throw new TypeError("Expected a string");
  }
  return string3.replace(/[|\\{}()[\]^$+*?.]/g, "\\$&").replace(/-/g, "\\x2d");
}

// node_modules/unist-util-is/lib/index.js
var convert = (
  // Note: overloads in JSDoc can’t yet use different `@template`s.
  /**
   * @type {(
   *   (<Condition extends string>(test: Condition) => (node: unknown, index?: number | null | undefined, parent?: Parent | null | undefined, context?: unknown) => node is Node & {type: Condition}) &
   *   (<Condition extends Props>(test: Condition) => (node: unknown, index?: number | null | undefined, parent?: Parent | null | undefined, context?: unknown) => node is Node & Condition) &
   *   (<Condition extends TestFunction>(test: Condition) => (node: unknown, index?: number | null | undefined, parent?: Parent | null | undefined, context?: unknown) => node is Node & Predicate<Condition, Node>) &
   *   ((test?: null | undefined) => (node?: unknown, index?: number | null | undefined, parent?: Parent | null | undefined, context?: unknown) => node is Node) &
   *   ((test?: Test) => Check)
   * )}
   */
  /**
   * @param {Test} [test]
   * @returns {Check}
   */
  (function(test) {
    if (test === null || test === void 0) {
      return ok2;
    }
    if (typeof test === "function") {
      return castFactory(test);
    }
    if (typeof test === "object") {
      return Array.isArray(test) ? anyFactory(test) : (
        // Cast because `ReadonlyArray` goes into the above but `isArray`
        // narrows to `Array`.
        propertiesFactory(
          /** @type {Props} */
          test
        )
      );
    }
    if (typeof test === "string") {
      return typeFactory(test);
    }
    throw new Error("Expected function, string, or object as test");
  })
);
function anyFactory(tests) {
  const checks = [];
  let index2 = -1;
  while (++index2 < tests.length) {
    checks[index2] = convert(tests[index2]);
  }
  return castFactory(any);
  function any(...parameters) {
    let index3 = -1;
    while (++index3 < checks.length) {
      if (checks[index3].apply(this, parameters)) return true;
    }
    return false;
  }
}
function propertiesFactory(check) {
  const checkAsRecord = (
    /** @type {Record<string, unknown>} */
    check
  );
  return castFactory(all2);
  function all2(node2) {
    const nodeAsRecord = (
      /** @type {Record<string, unknown>} */
      /** @type {unknown} */
      node2
    );
    let key;
    for (key in check) {
      if (nodeAsRecord[key] !== checkAsRecord[key]) return false;
    }
    return true;
  }
}
function typeFactory(check) {
  return castFactory(type);
  function type(node2) {
    return node2 && node2.type === check;
  }
}
function castFactory(testFunction) {
  return check;
  function check(value, index2, parent) {
    return Boolean(
      looksLikeANode(value) && testFunction.call(
        this,
        value,
        typeof index2 === "number" ? index2 : void 0,
        parent || void 0
      )
    );
  }
}
function ok2() {
  return true;
}
function looksLikeANode(value) {
  return value !== null && typeof value === "object" && "type" in value;
}

// node_modules/unist-util-visit-parents/lib/color.node.js
function color(d) {
  return "\x1B[33m" + d + "\x1B[39m";
}

// node_modules/unist-util-visit-parents/lib/index.js
var empty = [];
var CONTINUE = true;
var EXIT = false;
var SKIP = "skip";
function visitParents(tree, testOrEnterOrVisitors, enterOrVisitorsOrReverse, reverse) {
  if (!tree || typeof tree !== "object") {
    throw new Error("Unexpected value `" + tree + "` for `tree`, expected node");
  }
  let preorder = true;
  let check;
  let visitors;
  let enter;
  let exit3;
  if (typeof enterOrVisitorsOrReverse === "function" || enterOrVisitorsOrReverse && typeof enterOrVisitorsOrReverse === "object") {
    check = /** @type {Test} */
    testOrEnterOrVisitors;
    visitors = enterOrVisitorsOrReverse;
    if (reverse) preorder = false;
  } else {
    visitors = /** @type {Visitors | Visitor} */
    testOrEnterOrVisitors;
    if (enterOrVisitorsOrReverse) preorder = false;
  }
  if (typeof visitors === "function") {
    enter = visitors;
  } else if (visitors && typeof visitors === "object") {
    if (visitors.enter === null || visitors.enter === void 0) {
    } else if (typeof visitors.enter === "function") {
      enter = visitors.enter;
    } else {
      throw new Error(
        "Unexpected value `" + visitors.enter + "` for `visitors.enter`, expected optional visitor"
      );
    }
    if (typeof visitors.exit === "function") {
      exit3 = visitors.exit;
    } else {
      throw new Error(
        "Unexpected value `" + visitors.exit + "` for `visitors.exit`, expected visitor (pass a visitor directly if you only want an enter visitor)"
      );
    }
  } else {
    throw new Error(
      "Unexpected value `" + visitors + "` for `enter` or `visitors`, expected visitor or object with visitors"
    );
  }
  const is2 = convert(check);
  const step = preorder ? 1 : -1;
  factory(tree, void 0, [])();
  function factory(node2, index2, parents) {
    const value = (
      /** @type {Record<string, unknown>} */
      node2 && typeof node2 === "object" ? node2 : {}
    );
    if (typeof value.type === "string") {
      const name = (
        // `hast`
        typeof value.tagName === "string" ? value.tagName : (
          // `xast`
          typeof value.name === "string" ? value.name : void 0
        )
      );
      Object.defineProperty(visit2, "name", {
        value: "node (" + color(node2.type + (name ? "<" + name + ">" : "")) + ")"
      });
    }
    return visit2;
    function visit2() {
      const matches = !check || is2(node2, index2, parents[parents.length - 1] || void 0);
      let result = empty;
      if (enter && matches) {
        result = toResult(enter(node2, parents, index2));
        if (result[0] === EXIT) {
          return result;
        }
      }
      if ("children" in node2 && node2.children) {
        const nodeAsParent = (
          /** @type {UnistParent} */
          node2
        );
        if (nodeAsParent.children && result[0] !== SKIP) {
          let offset = (preorder ? -1 : nodeAsParent.children.length) + step;
          const grandparents = [...parents, nodeAsParent];
          while (offset > -1 && offset < nodeAsParent.children.length) {
            const child = nodeAsParent.children[offset];
            const subresult = factory(child, offset, grandparents)();
            if (subresult[0] === EXIT) {
              return subresult;
            }
            offset = typeof subresult[1] === "number" ? subresult[1] : offset + step;
          }
        }
      }
      if (exit3 && matches) {
        const exitResult = toResult(exit3(node2, parents, index2));
        if (exitResult[0] === SKIP) {
          throw new Error(
            "Unexpected value `" + exitResult[0] + "` from `exit`, expected `CONTINUE`, `EXIT`, index, or nothing"
          );
        }
        if (exitResult[0] === EXIT || typeof exitResult[1] === "number") {
          return exitResult;
        }
      }
      return result;
    }
  }
}
function toResult(value) {
  if (Array.isArray(value)) {
    return value;
  }
  if (typeof value === "number") {
    return [CONTINUE, value];
  }
  return value === null || value === void 0 ? empty : [value];
}

// node_modules/mdast-util-find-and-replace/lib/index.js
function findAndReplace(tree, list2, options) {
  const settings = options || {};
  const ignored = convert(settings.ignore || []);
  const pairs = toPairs(list2);
  let pairIndex = -1;
  while (++pairIndex < pairs.length) {
    visitParents(tree, visitor);
  }
  function visitor(node2, parents, index2) {
    if (node2.type === "text" && typeof index2 === "number") {
      return handler(node2, parents, index2);
    }
    if (ignored(node2, index2, parents[parents.length - 1])) return SKIP;
  }
  function handler(node2, parents, index2) {
    const parent = parents[parents.length - 1];
    const find = pairs[pairIndex][0];
    const replace2 = pairs[pairIndex][1];
    let start2 = 0;
    let change = false;
    let nodes = [];
    find.lastIndex = 0;
    let match = find.exec(node2.value);
    while (match) {
      const position2 = match.index;
      const matchObject = {
        index: match.index,
        input: match.input,
        stack: [...parents, node2]
      };
      let value = replace2(...match, matchObject);
      if (typeof value === "string") {
        value = value.length > 0 ? { type: "text", value } : void 0;
      }
      if (value === false) {
        find.lastIndex = position2 + 1;
      } else {
        if (start2 !== position2) {
          add({ type: "text", value: node2.value.slice(start2, position2) });
        }
        if (Array.isArray(value)) {
          for (const child of value) add(child);
        } else if (value) {
          add(value);
        }
        start2 = position2 + match[0].length;
        change = true;
      }
      if (!find.global) {
        break;
      }
      match = find.exec(node2.value);
    }
    if (change) {
      if (start2 < node2.value.length) {
        add({ type: "text", value: node2.value.slice(start2) });
      }
      parent.children.splice(index2, 1, ...nodes);
    } else {
      nodes = [node2];
    }
    return index2 + nodes.length;
    function add(child) {
      const previous3 = nodes[nodes.length - 1];
      if (previous3 && previous3.type === "text" && child.type === "text") {
        previous3.value += child.value;
      } else {
        nodes.push(child);
      }
    }
  }
}
function toPairs(tupleOrList) {
  if (!Array.isArray(tupleOrList)) {
    throw new TypeError("Expected find and replace tuple or list of tuples");
  }
  const result = [];
  const list2 = !tupleOrList[0] || Array.isArray(tupleOrList[0]) ? (
    /** @type {FindAndReplaceList} */
    tupleOrList
  ) : [
    /** @type {FindAndReplaceTuple} */
    tupleOrList
  ];
  let index2 = -1;
  while (++index2 < list2.length) {
    const tuple = list2[index2];
    result.push([toExpression(tuple[0]), toFunction(tuple[1])]);
  }
  return result;
}
function toExpression(find) {
  return typeof find === "string" ? new RegExp(escapeStringRegexp(find), "g") : find;
}
function toFunction(replace2) {
  return typeof replace2 === "function" ? replace2 : function() {
    return replace2;
  };
}

// node_modules/mdast-util-gfm-autolink-literal/lib/index.js
function gfmAutolinkLiteralFromMarkdown() {
  return {
    transforms: [transformGfmAutolinkLiterals],
    enter: {
      literalAutolink: enterLiteralAutolink,
      literalAutolinkEmail: enterLiteralAutolinkValue,
      literalAutolinkHttp: enterLiteralAutolinkValue,
      literalAutolinkWww: enterLiteralAutolinkValue
    },
    exit: {
      literalAutolink: exitLiteralAutolink,
      literalAutolinkEmail: exitLiteralAutolinkEmail,
      literalAutolinkHttp: exitLiteralAutolinkHttp,
      literalAutolinkWww: exitLiteralAutolinkWww
    }
  };
}
function enterLiteralAutolink(token) {
  this.enter({ type: "link", title: null, url: "", children: [] }, token);
}
function enterLiteralAutolinkValue(token) {
  this.config.enter.autolinkProtocol.call(this, token);
}
function exitLiteralAutolinkHttp(token) {
  this.config.exit.autolinkProtocol.call(this, token);
}
function exitLiteralAutolinkWww(token) {
  this.config.exit.data.call(this, token);
  const node2 = this.stack[this.stack.length - 1];
  ok(node2.type === "link");
  node2.url = "http://" + this.sliceSerialize(token);
}
function exitLiteralAutolinkEmail(token) {
  this.config.exit.autolinkEmail.call(this, token);
}
function exitLiteralAutolink(token) {
  this.exit(token);
}
function transformGfmAutolinkLiterals(tree) {
  findAndReplace(
    tree,
    [
      [/(https?:\/\/|www(?=\.))([-.\w]+)([^ \t\r\n]*)/gi, findUrl],
      [new RegExp("(?<=^|\\s|\\p{P}|\\p{S})([-.\\w+]+)@([-\\w]+(?:\\.[-\\w]+)+)", "gu"), findEmail]
    ],
    { ignore: ["link", "linkReference"] }
  );
}
function findUrl(_, protocol, domain2, path2, match) {
  let prefix = "";
  if (!previous2(match)) {
    return false;
  }
  if (/^w/i.test(protocol)) {
    domain2 = protocol + domain2;
    protocol = "";
    prefix = "http://";
  }
  if (!isCorrectDomain(domain2)) {
    return false;
  }
  const parts = splitUrl(domain2 + path2);
  if (!parts[0]) return false;
  const result = {
    type: "link",
    title: null,
    url: prefix + protocol + parts[0],
    children: [{ type: "text", value: protocol + parts[0] }]
  };
  if (parts[1]) {
    return [result, { type: "text", value: parts[1] }];
  }
  return result;
}
function findEmail(_, atext, label, match) {
  if (
    // Not an expected previous character.
    !previous2(match, true) || // Label ends in not allowed character.
    /[-\d_]$/.test(label)
  ) {
    return false;
  }
  return {
    type: "link",
    title: null,
    url: "mailto:" + atext + "@" + label,
    children: [{ type: "text", value: atext + "@" + label }]
  };
}
function isCorrectDomain(domain2) {
  const parts = domain2.split(".");
  if (parts.length < 2 || parts[parts.length - 1] && (/_/.test(parts[parts.length - 1]) || !/[a-zA-Z\d]/.test(parts[parts.length - 1])) || parts[parts.length - 2] && (/_/.test(parts[parts.length - 2]) || !/[a-zA-Z\d]/.test(parts[parts.length - 2]))) {
    return false;
  }
  return true;
}
function splitUrl(url) {
  const trailExec = /[!"&'),.:;<>?\]}]+$/.exec(url);
  if (!trailExec) {
    return [url, void 0];
  }
  url = url.slice(0, trailExec.index);
  let trail2 = trailExec[0];
  let closingParenIndex = trail2.indexOf(")");
  const openingParens = ccount(url, "(");
  let closingParens = ccount(url, ")");
  while (closingParenIndex !== -1 && openingParens > closingParens) {
    url += trail2.slice(0, closingParenIndex + 1);
    trail2 = trail2.slice(closingParenIndex + 1);
    closingParenIndex = trail2.indexOf(")");
    closingParens++;
  }
  return [url, trail2];
}
function previous2(match, email) {
  const code2 = match.input.charCodeAt(match.index - 1);
  return (match.index === 0 || unicodeWhitespace(code2) || unicodePunctuation(code2)) && // If it’s an email, the previous character should not be a slash.
  (!email || code2 !== 47);
}

// node_modules/mdast-util-gfm-footnote/lib/index.js
footnoteReference.peek = footnoteReferencePeek;
function enterFootnoteCallString() {
  this.buffer();
}
function enterFootnoteCall(token) {
  this.enter({ type: "footnoteReference", identifier: "", label: "" }, token);
}
function enterFootnoteDefinitionLabelString() {
  this.buffer();
}
function enterFootnoteDefinition(token) {
  this.enter(
    { type: "footnoteDefinition", identifier: "", label: "", children: [] },
    token
  );
}
function exitFootnoteCallString(token) {
  const label = this.resume();
  const node2 = this.stack[this.stack.length - 1];
  ok(node2.type === "footnoteReference");
  node2.identifier = normalizeIdentifier(
    this.sliceSerialize(token)
  ).toLowerCase();
  node2.label = label;
}
function exitFootnoteCall(token) {
  this.exit(token);
}
function exitFootnoteDefinitionLabelString(token) {
  const label = this.resume();
  const node2 = this.stack[this.stack.length - 1];
  ok(node2.type === "footnoteDefinition");
  node2.identifier = normalizeIdentifier(
    this.sliceSerialize(token)
  ).toLowerCase();
  node2.label = label;
}
function exitFootnoteDefinition(token) {
  this.exit(token);
}
function footnoteReferencePeek() {
  return "[";
}
function footnoteReference(node2, _, state, info) {
  const tracker = state.createTracker(info);
  let value = tracker.move("[^");
  const exit3 = state.enter("footnoteReference");
  const subexit = state.enter("reference");
  value += tracker.move(
    state.safe(state.associationId(node2), { after: "]", before: value })
  );
  subexit();
  exit3();
  value += tracker.move("]");
  return value;
}
function gfmFootnoteFromMarkdown() {
  return {
    enter: {
      gfmFootnoteCallString: enterFootnoteCallString,
      gfmFootnoteCall: enterFootnoteCall,
      gfmFootnoteDefinitionLabelString: enterFootnoteDefinitionLabelString,
      gfmFootnoteDefinition: enterFootnoteDefinition
    },
    exit: {
      gfmFootnoteCallString: exitFootnoteCallString,
      gfmFootnoteCall: exitFootnoteCall,
      gfmFootnoteDefinitionLabelString: exitFootnoteDefinitionLabelString,
      gfmFootnoteDefinition: exitFootnoteDefinition
    }
  };
}

// node_modules/mdast-util-gfm-strikethrough/lib/index.js
handleDelete.attention = attentionDelete;
handleDelete.peek = peekDelete;
function gfmStrikethroughFromMarkdown() {
  return {
    canContainEols: ["delete"],
    enter: { strikethrough: enterStrikethrough },
    exit: { strikethrough: exitStrikethrough }
  };
}
function enterStrikethrough(token) {
  this.enter({ type: "delete", children: [], position: void 0 }, token);
}
function exitStrikethrough(token) {
  this.exit(token);
}
function handleDelete(node2, _, state, info) {
  const tracker = state.createTracker(info);
  const sequence = state.stack.includes("strikethrough") ? "~" : "~~";
  const exit3 = state.enter("strikethrough");
  let value = tracker.move(sequence);
  value += state.containerPhrasing(node2, {
    ...tracker.current(),
    before: value,
    after: "~"
  });
  value += tracker.move(sequence);
  exit3();
  return value;
}
function attentionDelete() {
  return { construct: "strikethrough", markers: ["~"], sizes: [2, 1] };
}
function peekDelete() {
  return "~";
}

// node_modules/mdast-util-gfm-table/lib/index.js
function gfmTableFromMarkdown() {
  return {
    enter: {
      table: enterTable,
      tableData: enterCell,
      tableHeader: enterCell,
      tableRow: enterRow
    },
    exit: {
      codeText: exitCodeText,
      table: exitTable,
      tableData: exit2,
      tableHeader: exit2,
      tableRow: exit2
    }
  };
}
function enterTable(token) {
  const align = token._align;
  ok(align, "expected `_align` on table");
  this.enter(
    {
      type: "table",
      align: align.map(function(d) {
        return d === "none" ? null : d;
      }),
      children: []
    },
    token
  );
  this.data.inTable = true;
}
function exitTable(token) {
  this.exit(token);
  this.data.inTable = void 0;
}
function enterRow(token) {
  this.enter({ type: "tableRow", children: [] }, token);
}
function exit2(token) {
  this.exit(token);
}
function enterCell(token) {
  this.enter({ type: "tableCell", children: [] }, token);
}
function exitCodeText(token) {
  let value = this.resume();
  if (this.data.inTable) {
    value = value.replace(/\\([\\|])/g, replace);
  }
  const node2 = this.stack[this.stack.length - 1];
  ok(node2.type === "inlineCode");
  node2.value = value;
  this.exit(token);
}
function replace($0, $1) {
  return $1 === "|" ? $1 : $0;
}

// node_modules/mdast-util-gfm-task-list-item/lib/index.js
function gfmTaskListItemFromMarkdown() {
  return {
    exit: {
      taskListCheckValueChecked: exitCheck,
      taskListCheckValueUnchecked: exitCheck,
      paragraph: exitParagraphWithTaskListItem
    }
  };
}
function exitCheck(token) {
  const node2 = this.stack[this.stack.length - 2];
  ok(node2.type === "listItem");
  node2.checked = token.type === "taskListCheckValueChecked";
}
function exitParagraphWithTaskListItem(token) {
  const parent = this.stack[this.stack.length - 2];
  if (parent && parent.type === "listItem" && typeof parent.checked === "boolean") {
    const node2 = this.stack[this.stack.length - 1];
    ok(node2.type === "paragraph");
    const head = node2.children[0];
    if (head && head.type === "text") {
      const siblings = parent.children;
      let index2 = -1;
      let firstParaghraph;
      while (++index2 < siblings.length) {
        const sibling = siblings[index2];
        if (sibling.type === "paragraph") {
          firstParaghraph = sibling;
          break;
        }
      }
      if (firstParaghraph === node2) {
        head.value = head.value.slice(1);
        if (head.value.length === 0) {
          node2.children.shift();
        } else if (node2.position && head.position && typeof head.position.start.offset === "number") {
          head.position.start.column++;
          head.position.start.offset++;
          node2.position.start = Object.assign({}, head.position.start);
        }
      }
    }
  }
  this.exit(token);
}

// node_modules/mdast-util-gfm/lib/index.js
function gfmFromMarkdown() {
  return [
    gfmAutolinkLiteralFromMarkdown(),
    gfmFootnoteFromMarkdown(),
    gfmStrikethroughFromMarkdown(),
    gfmTableFromMarkdown(),
    gfmTaskListItemFromMarkdown()
  ];
}

// node_modules/micromark-extension-gfm-autolink-literal/lib/syntax.js
var wwwPrefix = {
  tokenize: tokenizeWwwPrefix,
  partial: true
};
var domain = {
  tokenize: tokenizeDomain,
  partial: true
};
var path = {
  tokenize: tokenizePath,
  partial: true
};
var trail = {
  tokenize: tokenizeTrail,
  partial: true
};
var emailDomainDotTrail = {
  tokenize: tokenizeEmailDomainDotTrail,
  partial: true
};
var wwwAutolink = {
  name: "wwwAutolink",
  tokenize: tokenizeWwwAutolink,
  previous: previousWww
};
var protocolAutolink = {
  name: "protocolAutolink",
  tokenize: tokenizeProtocolAutolink,
  previous: previousProtocol
};
var emailAutolink = {
  name: "emailAutolink",
  tokenize: tokenizeEmailAutolink,
  previous: previousEmail
};
var text3 = {};
function gfmAutolinkLiteral() {
  return {
    text: text3
  };
}
var code = 48;
while (code < 123) {
  text3[code] = emailAutolink;
  code++;
  if (code === 58) code = 65;
  else if (code === 91) code = 97;
}
text3[43] = emailAutolink;
text3[45] = emailAutolink;
text3[46] = emailAutolink;
text3[95] = emailAutolink;
text3[72] = [emailAutolink, protocolAutolink];
text3[104] = [emailAutolink, protocolAutolink];
text3[87] = [emailAutolink, wwwAutolink];
text3[119] = [emailAutolink, wwwAutolink];
function tokenizeEmailAutolink(effects, ok3, nok) {
  const self = this;
  let dot;
  let data;
  return start2;
  function start2(code2) {
    if (!gfmAtext(code2) || !previousEmail.call(self, self.previous) || previousUnbalanced(self.events)) {
      return nok(code2);
    }
    effects.enter("literalAutolink");
    effects.enter("literalAutolinkEmail");
    return atext(code2);
  }
  function atext(code2) {
    if (gfmAtext(code2)) {
      effects.consume(code2);
      return atext;
    }
    if (code2 === 64) {
      effects.consume(code2);
      return emailDomain;
    }
    return nok(code2);
  }
  function emailDomain(code2) {
    if (code2 === 46) {
      return effects.check(emailDomainDotTrail, emailDomainAfter, emailDomainDot)(code2);
    }
    if (code2 === 45 || code2 === 95 || asciiAlphanumeric(code2)) {
      data = true;
      effects.consume(code2);
      return emailDomain;
    }
    return emailDomainAfter(code2);
  }
  function emailDomainDot(code2) {
    effects.consume(code2);
    dot = true;
    return emailDomain;
  }
  function emailDomainAfter(code2) {
    if (data && dot && asciiAlpha(self.previous)) {
      effects.exit("literalAutolinkEmail");
      effects.exit("literalAutolink");
      return ok3(code2);
    }
    return nok(code2);
  }
}
function tokenizeWwwAutolink(effects, ok3, nok) {
  const self = this;
  return wwwStart;
  function wwwStart(code2) {
    if (code2 !== 87 && code2 !== 119 || !previousWww.call(self, self.previous) || previousUnbalanced(self.events)) {
      return nok(code2);
    }
    effects.enter("literalAutolink");
    effects.enter("literalAutolinkWww");
    return effects.check(wwwPrefix, effects.attempt(domain, effects.attempt(path, wwwAfter), nok), nok)(code2);
  }
  function wwwAfter(code2) {
    effects.exit("literalAutolinkWww");
    effects.exit("literalAutolink");
    return ok3(code2);
  }
}
function tokenizeProtocolAutolink(effects, ok3, nok) {
  const self = this;
  let buffer = "";
  let seen = false;
  return protocolStart;
  function protocolStart(code2) {
    if ((code2 === 72 || code2 === 104) && previousProtocol.call(self, self.previous) && !previousUnbalanced(self.events)) {
      effects.enter("literalAutolink");
      effects.enter("literalAutolinkHttp");
      buffer += String.fromCodePoint(code2);
      effects.consume(code2);
      return protocolPrefixInside;
    }
    return nok(code2);
  }
  function protocolPrefixInside(code2) {
    if (asciiAlpha(code2) && buffer.length < 5) {
      buffer += String.fromCodePoint(code2);
      effects.consume(code2);
      return protocolPrefixInside;
    }
    if (code2 === 58) {
      const protocol = buffer.toLowerCase();
      if (protocol === "http" || protocol === "https") {
        effects.consume(code2);
        return protocolSlashesInside;
      }
    }
    return nok(code2);
  }
  function protocolSlashesInside(code2) {
    if (code2 === 47) {
      effects.consume(code2);
      if (seen) {
        return afterProtocol;
      }
      seen = true;
      return protocolSlashesInside;
    }
    return nok(code2);
  }
  function afterProtocol(code2) {
    return code2 === null || asciiControl(code2) || markdownLineEndingOrSpace(code2) || unicodeWhitespace(code2) || unicodePunctuation(code2) ? nok(code2) : effects.attempt(domain, effects.attempt(path, protocolAfter), nok)(code2);
  }
  function protocolAfter(code2) {
    effects.exit("literalAutolinkHttp");
    effects.exit("literalAutolink");
    return ok3(code2);
  }
}
function tokenizeWwwPrefix(effects, ok3, nok) {
  let size = 0;
  return wwwPrefixInside;
  function wwwPrefixInside(code2) {
    if ((code2 === 87 || code2 === 119) && size < 3) {
      size++;
      effects.consume(code2);
      return wwwPrefixInside;
    }
    if (code2 === 46 && size === 3) {
      effects.consume(code2);
      return wwwPrefixAfter;
    }
    return nok(code2);
  }
  function wwwPrefixAfter(code2) {
    return code2 === null ? nok(code2) : ok3(code2);
  }
}
function tokenizeDomain(effects, ok3, nok) {
  let underscoreInLastSegment;
  let underscoreInLastLastSegment;
  let seen;
  return domainInside;
  function domainInside(code2) {
    if (code2 === 46 || code2 === 95) {
      return effects.check(trail, domainAfter, domainAtPunctuation)(code2);
    }
    if (code2 === null || markdownLineEndingOrSpace(code2) || unicodeWhitespace(code2) || code2 !== 45 && unicodePunctuation(code2)) {
      return domainAfter(code2);
    }
    seen = true;
    effects.consume(code2);
    return domainInside;
  }
  function domainAtPunctuation(code2) {
    if (code2 === 95) {
      underscoreInLastSegment = true;
    } else {
      underscoreInLastLastSegment = underscoreInLastSegment;
      underscoreInLastSegment = void 0;
    }
    effects.consume(code2);
    return domainInside;
  }
  function domainAfter(code2) {
    if (underscoreInLastLastSegment || underscoreInLastSegment || !seen) {
      return nok(code2);
    }
    return ok3(code2);
  }
}
function tokenizePath(effects, ok3) {
  let sizeOpen = 0;
  let sizeClose = 0;
  return pathInside;
  function pathInside(code2) {
    if (code2 === 40) {
      sizeOpen++;
      effects.consume(code2);
      return pathInside;
    }
    if (code2 === 41 && sizeClose < sizeOpen) {
      return pathAtPunctuation(code2);
    }
    if (code2 === 33 || code2 === 34 || code2 === 38 || code2 === 39 || code2 === 41 || code2 === 42 || code2 === 44 || code2 === 46 || code2 === 58 || code2 === 59 || code2 === 60 || code2 === 63 || code2 === 93 || code2 === 95 || code2 === 126) {
      return effects.check(trail, ok3, pathAtPunctuation)(code2);
    }
    if (code2 === null || markdownLineEndingOrSpace(code2) || unicodeWhitespace(code2)) {
      return ok3(code2);
    }
    effects.consume(code2);
    return pathInside;
  }
  function pathAtPunctuation(code2) {
    if (code2 === 41) {
      sizeClose++;
    }
    effects.consume(code2);
    return pathInside;
  }
}
function tokenizeTrail(effects, ok3, nok) {
  return trail2;
  function trail2(code2) {
    if (code2 === 33 || code2 === 34 || code2 === 39 || code2 === 41 || code2 === 42 || code2 === 44 || code2 === 46 || code2 === 58 || code2 === 59 || code2 === 63 || code2 === 95 || code2 === 126) {
      effects.consume(code2);
      return trail2;
    }
    if (code2 === 38) {
      effects.consume(code2);
      return trailCharacterReferenceStart;
    }
    if (code2 === 93) {
      effects.consume(code2);
      return trailBracketAfter;
    }
    if (
      // `<` is an end.
      code2 === 60 || // So is whitespace.
      code2 === null || markdownLineEndingOrSpace(code2) || unicodeWhitespace(code2)
    ) {
      return ok3(code2);
    }
    return nok(code2);
  }
  function trailBracketAfter(code2) {
    if (code2 === null || code2 === 40 || code2 === 91 || markdownLineEndingOrSpace(code2) || unicodeWhitespace(code2)) {
      return ok3(code2);
    }
    return trail2(code2);
  }
  function trailCharacterReferenceStart(code2) {
    return asciiAlpha(code2) ? trailCharacterReferenceInside(code2) : nok(code2);
  }
  function trailCharacterReferenceInside(code2) {
    if (code2 === 59) {
      effects.consume(code2);
      return trail2;
    }
    if (asciiAlpha(code2)) {
      effects.consume(code2);
      return trailCharacterReferenceInside;
    }
    return nok(code2);
  }
}
function tokenizeEmailDomainDotTrail(effects, ok3, nok) {
  return start2;
  function start2(code2) {
    effects.consume(code2);
    return after;
  }
  function after(code2) {
    return asciiAlphanumeric(code2) ? nok(code2) : ok3(code2);
  }
}
function previousWww(code2) {
  return code2 === null || code2 === 40 || code2 === 42 || code2 === 95 || code2 === 91 || code2 === 93 || code2 === 126 || markdownLineEndingOrSpace(code2);
}
function previousProtocol(code2) {
  return !asciiAlpha(code2);
}
function previousEmail(code2) {
  return !(code2 === 47 || gfmAtext(code2));
}
function gfmAtext(code2) {
  return code2 === 43 || code2 === 45 || code2 === 46 || code2 === 95 || asciiAlphanumeric(code2);
}
function previousUnbalanced(events) {
  let index2 = events.length;
  let result = false;
  while (index2--) {
    const token = events[index2][1];
    if ((token.type === "labelLink" || token.type === "labelImage") && !token._balanced) {
      result = true;
      break;
    }
    if (token._gfmAutolinkLiteralWalkedInto) {
      result = false;
      break;
    }
  }
  if (events.length > 0 && !result) {
    events[events.length - 1][1]._gfmAutolinkLiteralWalkedInto = true;
  }
  return result;
}

// node_modules/micromark-extension-gfm-footnote/lib/syntax.js
var indent = {
  tokenize: tokenizeIndent2,
  partial: true
};
function gfmFootnote() {
  return {
    document: {
      [91]: {
        name: "gfmFootnoteDefinition",
        tokenize: tokenizeDefinitionStart,
        continuation: {
          tokenize: tokenizeDefinitionContinuation
        },
        exit: gfmFootnoteDefinitionEnd
      }
    },
    text: {
      [91]: {
        name: "gfmFootnoteCall",
        tokenize: tokenizeGfmFootnoteCall
      },
      [93]: {
        name: "gfmPotentialFootnoteCall",
        add: "after",
        tokenize: tokenizePotentialGfmFootnoteCall,
        resolveTo: resolveToPotentialGfmFootnoteCall
      }
    }
  };
}
function tokenizePotentialGfmFootnoteCall(effects, ok3, nok) {
  const self = this;
  let index2 = self.events.length;
  const defined = self.parser.gfmFootnotes || (self.parser.gfmFootnotes = []);
  let labelStart;
  while (index2--) {
    const token = self.events[index2][1];
    if (token.type === "labelImage") {
      labelStart = token;
      break;
    }
    if (token.type === "gfmFootnoteCall" || token.type === "labelLink" || token.type === "label" || token.type === "image" || token.type === "link") {
      break;
    }
  }
  return start2;
  function start2(code2) {
    if (!labelStart || !labelStart._balanced) {
      return nok(code2);
    }
    const id = normalizeIdentifier(self.sliceSerialize({
      start: labelStart.end,
      end: self.now()
    }));
    if (id.codePointAt(0) !== 94 || !defined.includes(id.slice(1))) {
      return nok(code2);
    }
    effects.enter("gfmFootnoteCallLabelMarker");
    effects.consume(code2);
    effects.exit("gfmFootnoteCallLabelMarker");
    return ok3(code2);
  }
}
function resolveToPotentialGfmFootnoteCall(events, context) {
  let index2 = events.length;
  let labelStart;
  while (index2--) {
    if (events[index2][1].type === "labelImage" && events[index2][0] === "enter") {
      labelStart = events[index2][1];
      break;
    }
  }
  events[index2 + 1][1].type = "data";
  events[index2 + 3][1].type = "gfmFootnoteCallLabelMarker";
  const call = {
    type: "gfmFootnoteCall",
    start: Object.assign({}, events[index2 + 3][1].start),
    end: Object.assign({}, events[events.length - 1][1].end)
  };
  const marker = {
    type: "gfmFootnoteCallMarker",
    start: Object.assign({}, events[index2 + 3][1].end),
    end: Object.assign({}, events[index2 + 3][1].end)
  };
  marker.end.column++;
  marker.end.offset++;
  marker.end._bufferIndex++;
  const string3 = {
    type: "gfmFootnoteCallString",
    start: Object.assign({}, marker.end),
    end: Object.assign({}, events[events.length - 1][1].start)
  };
  const chunk = {
    type: "chunkString",
    contentType: "string",
    start: Object.assign({}, string3.start),
    end: Object.assign({}, string3.end)
  };
  const replacement = [
    // Take the `labelImageMarker` (now `data`, the `!`)
    events[index2 + 1],
    events[index2 + 2],
    ["enter", call, context],
    // The `[`
    events[index2 + 3],
    events[index2 + 4],
    // The `^`.
    ["enter", marker, context],
    ["exit", marker, context],
    // Everything in between.
    ["enter", string3, context],
    ["enter", chunk, context],
    ["exit", chunk, context],
    ["exit", string3, context],
    // The ending (`]`, properly parsed and labelled).
    events[events.length - 2],
    events[events.length - 1],
    ["exit", call, context]
  ];
  events.splice(index2, events.length - index2 + 1, ...replacement);
  return events;
}
function tokenizeGfmFootnoteCall(effects, ok3, nok) {
  const self = this;
  const defined = self.parser.gfmFootnotes || (self.parser.gfmFootnotes = []);
  let size = 0;
  let data;
  return start2;
  function start2(code2) {
    effects.enter("gfmFootnoteCall");
    effects.enter("gfmFootnoteCallLabelMarker");
    effects.consume(code2);
    effects.exit("gfmFootnoteCallLabelMarker");
    return callStart;
  }
  function callStart(code2) {
    if (code2 !== 94) return nok(code2);
    effects.enter("gfmFootnoteCallMarker");
    effects.consume(code2);
    effects.exit("gfmFootnoteCallMarker");
    effects.enter("gfmFootnoteCallString");
    effects.enter("chunkString").contentType = "string";
    return callData;
  }
  function callData(code2) {
    if (
      // Too long.
      size > 999 || // Closing brace with nothing.
      code2 === 93 && !data || // Space or tab is not supported by GFM for some reason.
      // `\n` and `[` not being supported makes sense.
      code2 === null || code2 === 91 || markdownLineEndingOrSpace(code2)
    ) {
      return nok(code2);
    }
    if (code2 === 93) {
      effects.exit("chunkString");
      const token = effects.exit("gfmFootnoteCallString");
      if (!defined.includes(normalizeIdentifier(self.sliceSerialize(token)))) {
        return nok(code2);
      }
      effects.enter("gfmFootnoteCallLabelMarker");
      effects.consume(code2);
      effects.exit("gfmFootnoteCallLabelMarker");
      effects.exit("gfmFootnoteCall");
      return ok3;
    }
    if (!markdownLineEndingOrSpace(code2)) {
      data = true;
    }
    size++;
    effects.consume(code2);
    return code2 === 92 ? callEscape : callData;
  }
  function callEscape(code2) {
    if (code2 === 91 || code2 === 92 || code2 === 93) {
      effects.consume(code2);
      size++;
      return callData;
    }
    return callData(code2);
  }
}
function tokenizeDefinitionStart(effects, ok3, nok) {
  const self = this;
  const defined = self.parser.gfmFootnotes || (self.parser.gfmFootnotes = []);
  let identifier;
  let size = 0;
  let data;
  return start2;
  function start2(code2) {
    effects.enter("gfmFootnoteDefinition")._container = true;
    effects.enter("gfmFootnoteDefinitionLabel");
    effects.enter("gfmFootnoteDefinitionLabelMarker");
    effects.consume(code2);
    effects.exit("gfmFootnoteDefinitionLabelMarker");
    return labelAtMarker;
  }
  function labelAtMarker(code2) {
    if (code2 === 94) {
      effects.enter("gfmFootnoteDefinitionMarker");
      effects.consume(code2);
      effects.exit("gfmFootnoteDefinitionMarker");
      effects.enter("gfmFootnoteDefinitionLabelString");
      effects.enter("chunkString").contentType = "string";
      return labelInside;
    }
    return nok(code2);
  }
  function labelInside(code2) {
    if (
      // Too long.
      size > 999 || // Closing brace with nothing.
      code2 === 93 && !data || // Space or tab is not supported by GFM for some reason.
      // `\n` and `[` not being supported makes sense.
      code2 === null || code2 === 91 || markdownLineEndingOrSpace(code2)
    ) {
      return nok(code2);
    }
    if (code2 === 93) {
      effects.exit("chunkString");
      const token = effects.exit("gfmFootnoteDefinitionLabelString");
      identifier = normalizeIdentifier(self.sliceSerialize(token));
      effects.enter("gfmFootnoteDefinitionLabelMarker");
      effects.consume(code2);
      effects.exit("gfmFootnoteDefinitionLabelMarker");
      effects.exit("gfmFootnoteDefinitionLabel");
      return labelAfter;
    }
    if (!markdownLineEndingOrSpace(code2)) {
      data = true;
    }
    size++;
    effects.consume(code2);
    return code2 === 92 ? labelEscape : labelInside;
  }
  function labelEscape(code2) {
    if (code2 === 91 || code2 === 92 || code2 === 93) {
      effects.consume(code2);
      size++;
      return labelInside;
    }
    return labelInside(code2);
  }
  function labelAfter(code2) {
    if (code2 === 58) {
      effects.enter("definitionMarker");
      effects.consume(code2);
      effects.exit("definitionMarker");
      if (!defined.includes(identifier)) {
        defined.push(identifier);
      }
      return factorySpace(effects, whitespaceAfter, "gfmFootnoteDefinitionWhitespace");
    }
    return nok(code2);
  }
  function whitespaceAfter(code2) {
    return ok3(code2);
  }
}
function tokenizeDefinitionContinuation(effects, ok3, nok) {
  return effects.check(blankLine, ok3, effects.attempt(indent, ok3, nok));
}
function gfmFootnoteDefinitionEnd(effects) {
  effects.exit("gfmFootnoteDefinition");
}
function tokenizeIndent2(effects, ok3, nok) {
  const self = this;
  return factorySpace(effects, afterPrefix, "gfmFootnoteDefinitionIndent", 4 + 1);
  function afterPrefix(code2) {
    const tail = self.events[self.events.length - 1];
    return tail && tail[1].type === "gfmFootnoteDefinitionIndent" && tail[2].sliceSerialize(tail[1], true).length === 4 ? ok3(code2) : nok(code2);
  }
}

// node_modules/micromark-extension-gfm-strikethrough/lib/syntax.js
function gfmStrikethrough(options) {
  const options_ = options || {};
  let single = options_.singleTilde;
  const tokenizer = {
    name: "strikethrough",
    tokenize: tokenizeStrikethrough,
    resolveAll: resolveAllStrikethrough
  };
  if (single === null || single === void 0) {
    single = true;
  }
  return {
    text: {
      [126]: tokenizer
    },
    insideSpan: {
      null: [tokenizer]
    },
    attentionMarkers: {
      null: [126]
    }
  };
  function resolveAllStrikethrough(events, context) {
    let index2 = -1;
    while (++index2 < events.length) {
      if (events[index2][0] === "enter" && events[index2][1].type === "strikethroughSequenceTemporary" && events[index2][1]._close) {
        let open = index2;
        while (open--) {
          if (events[open][0] === "exit" && events[open][1].type === "strikethroughSequenceTemporary" && events[open][1]._open && // If the sizes are the same:
          events[index2][1].end.offset - events[index2][1].start.offset === events[open][1].end.offset - events[open][1].start.offset) {
            events[index2][1].type = "strikethroughSequence";
            events[open][1].type = "strikethroughSequence";
            const strikethrough = {
              type: "strikethrough",
              start: Object.assign({}, events[open][1].start),
              end: Object.assign({}, events[index2][1].end)
            };
            const text4 = {
              type: "strikethroughText",
              start: Object.assign({}, events[open][1].end),
              end: Object.assign({}, events[index2][1].start)
            };
            const nextEvents = [["enter", strikethrough, context], ["enter", events[open][1], context], ["exit", events[open][1], context], ["enter", text4, context]];
            const insideSpan2 = context.parser.constructs.insideSpan.null;
            if (insideSpan2) {
              splice(nextEvents, nextEvents.length, 0, resolveAll(insideSpan2, events.slice(open + 1, index2), context));
            }
            splice(nextEvents, nextEvents.length, 0, [["exit", text4, context], ["enter", events[index2][1], context], ["exit", events[index2][1], context], ["exit", strikethrough, context]]);
            splice(events, open - 1, index2 - open + 3, nextEvents);
            index2 = open + nextEvents.length - 2;
            break;
          }
        }
      }
    }
    index2 = -1;
    while (++index2 < events.length) {
      if (events[index2][1].type === "strikethroughSequenceTemporary") {
        events[index2][1].type = "data";
      }
    }
    return events;
  }
  function tokenizeStrikethrough(effects, ok3, nok) {
    const previous3 = this.previous;
    const events = this.events;
    let size = 0;
    return start2;
    function start2(code2) {
      if (previous3 === 126 && events[events.length - 1][1].type !== "characterEscape") {
        return nok(code2);
      }
      effects.enter("strikethroughSequenceTemporary");
      return more(code2);
    }
    function more(code2) {
      const before = classifyCharacter(previous3);
      if (code2 === 126) {
        if (size > 1) return nok(code2);
        effects.consume(code2);
        size++;
        return more;
      }
      if (size < 2 && !single) return nok(code2);
      const token = effects.exit("strikethroughSequenceTemporary");
      const after = classifyCharacter(code2);
      token._open = !after || after === 2 && Boolean(before);
      token._close = !before || before === 2 && Boolean(after);
      return ok3(code2);
    }
  }
}

// node_modules/micromark-extension-gfm-table/lib/edit-map.js
var EditMap2 = class {
  /**
   * Create a new edit map.
   */
  constructor() {
    this.map = [];
    this.index = /* @__PURE__ */ new Map();
  }
  /**
   * Create an edit: a remove and/or add at a certain place.
   *
   * @param {number} index
   *   Index at which to apply the edit.
   * @param {number} remove
   *   Count of items to remove at the index.
   * @param {Array<Event>} add
   *   Items to add at the index.
   * @returns {undefined}
   *   Nothing.
   */
  add(index2, remove, add) {
    addImplementation2(this, index2, remove, add);
  }
  // To do: add this when moving to `micromark`.
  // /**
  //  * Create an edit: but insert `add` before existing additions.
  //  *
  //  * @param {number} index
  //  * @param {number} remove
  //  * @param {Array<Event>} add
  //  * @returns {undefined}
  //  */
  // addBefore(index, remove, add) {
  //   addImplementation(this, index, remove, add, true)
  // }
  /**
   * Done, change the events.
   *
   * @param {Array<Event>} events
   *   List of events to apply the edits to.
   * @returns {undefined}
   *   Nothing.
   */
  consume(events) {
    this.map.sort(function(a, b) {
      return a[0] - b[0];
    });
    if (this.map.length === 0) {
      return;
    }
    let index2 = this.map.length;
    const vecs = [];
    while (index2 > 0) {
      index2 -= 1;
      vecs.push(events.slice(this.map[index2][0] + this.map[index2][1]), this.map[index2][2]);
      events.length = this.map[index2][0];
    }
    vecs.push(events.slice());
    events.length = 0;
    let slice = vecs.pop();
    while (slice) {
      for (const element of slice) {
        events.push(element);
      }
      slice = vecs.pop();
    }
    this.map.length = 0;
    this.index.clear();
  }
};
function addImplementation2(editMap, at, remove, add) {
  if (remove === 0 && add.length === 0) {
    return;
  }
  const existing = editMap.index.get(at);
  if (existing) {
    existing[1] += remove;
    existing[2].push(...add);
    return;
  }
  const change = [at, remove, add];
  editMap.map.push(change);
  editMap.index.set(at, change);
}

// node_modules/micromark-extension-gfm-table/lib/infer.js
function gfmTableAlign(events, index2) {
  let inDelimiterRow = false;
  const align = [];
  while (index2 < events.length) {
    const event = events[index2];
    if (inDelimiterRow) {
      if (event[0] === "enter") {
        if (event[1].type === "tableContent") {
          align.push(events[index2 + 1][1].type === "tableDelimiterMarker" ? "left" : "none");
        }
      } else if (event[1].type === "tableContent") {
        if (events[index2 - 1][1].type === "tableDelimiterMarker") {
          const alignIndex = align.length - 1;
          align[alignIndex] = align[alignIndex] === "left" ? "center" : "right";
        }
      } else if (event[1].type === "tableDelimiterRow") {
        break;
      }
    } else if (event[0] === "enter" && event[1].type === "tableDelimiterRow") {
      inDelimiterRow = true;
    }
    index2 += 1;
  }
  return align;
}

// node_modules/micromark-extension-gfm-table/lib/syntax.js
function gfmTable() {
  return {
    flow: {
      null: {
        name: "table",
        tokenize: tokenizeTable,
        resolveAll: resolveTable
      }
    }
  };
}
function tokenizeTable(effects, ok3, nok) {
  const self = this;
  let size = 0;
  let sizeB = 0;
  let seen;
  return start2;
  function start2(code2) {
    let index2 = self.events.length - 1;
    while (index2 > -1) {
      const {
        type
      } = self.events[index2][1];
      if (type === "lineEnding" || // Note: markdown-rs uses `whitespace` instead of `linePrefix`
      type === "linePrefix") {
        index2--;
      } else {
        break;
      }
    }
    const tail = index2 > -1 ? self.events[index2][1].type : null;
    const next = tail === "tableHead" || tail === "tableRow" ? bodyRowStart : headRowBefore;
    if (next === bodyRowStart && self.parser.lazy[self.now().line]) {
      return nok(code2);
    }
    return next(code2);
  }
  function headRowBefore(code2) {
    effects.enter("tableHead");
    effects.enter("tableRow");
    return headRowStart(code2);
  }
  function headRowStart(code2) {
    if (code2 === 124) {
      return headRowBreak(code2);
    }
    seen = true;
    sizeB += 1;
    return headRowBreak(code2);
  }
  function headRowBreak(code2) {
    if (code2 === null) {
      return nok(code2);
    }
    if (markdownLineEnding(code2)) {
      if (sizeB > 1) {
        sizeB = 0;
        self.interrupt = true;
        effects.exit("tableRow");
        effects.enter("lineEnding");
        effects.consume(code2);
        effects.exit("lineEnding");
        return headDelimiterStart;
      }
      return nok(code2);
    }
    if (markdownSpace(code2)) {
      return factorySpace(effects, headRowBreak, "whitespace")(code2);
    }
    sizeB += 1;
    if (seen) {
      seen = false;
      size += 1;
    }
    if (code2 === 124) {
      effects.enter("tableCellDivider");
      effects.consume(code2);
      effects.exit("tableCellDivider");
      seen = true;
      return headRowBreak;
    }
    effects.enter("data");
    return headRowData(code2);
  }
  function headRowData(code2) {
    if (code2 === null || code2 === 124 || markdownLineEndingOrSpace(code2)) {
      effects.exit("data");
      return headRowBreak(code2);
    }
    effects.consume(code2);
    return code2 === 92 ? headRowEscape : headRowData;
  }
  function headRowEscape(code2) {
    if (code2 === 92 || code2 === 124) {
      effects.consume(code2);
      return headRowData;
    }
    return headRowData(code2);
  }
  function headDelimiterStart(code2) {
    self.interrupt = false;
    if (self.parser.lazy[self.now().line]) {
      return nok(code2);
    }
    effects.enter("tableDelimiterRow");
    seen = false;
    if (markdownSpace(code2)) {
      return factorySpace(effects, headDelimiterBefore, "linePrefix", self.parser.constructs.disable.null.includes("codeIndented") ? void 0 : 4)(code2);
    }
    return headDelimiterBefore(code2);
  }
  function headDelimiterBefore(code2) {
    if (code2 === 45 || code2 === 58) {
      return headDelimiterValueBefore(code2);
    }
    if (code2 === 124) {
      seen = true;
      effects.enter("tableCellDivider");
      effects.consume(code2);
      effects.exit("tableCellDivider");
      return headDelimiterCellBefore;
    }
    return headDelimiterNok(code2);
  }
  function headDelimiterCellBefore(code2) {
    if (markdownSpace(code2)) {
      return factorySpace(effects, headDelimiterValueBefore, "whitespace")(code2);
    }
    return headDelimiterValueBefore(code2);
  }
  function headDelimiterValueBefore(code2) {
    if (code2 === 58) {
      sizeB += 1;
      seen = true;
      effects.enter("tableDelimiterMarker");
      effects.consume(code2);
      effects.exit("tableDelimiterMarker");
      return headDelimiterLeftAlignmentAfter;
    }
    if (code2 === 45) {
      sizeB += 1;
      return headDelimiterLeftAlignmentAfter(code2);
    }
    if (code2 === null || markdownLineEnding(code2)) {
      return headDelimiterCellAfter(code2);
    }
    return headDelimiterNok(code2);
  }
  function headDelimiterLeftAlignmentAfter(code2) {
    if (code2 === 45) {
      effects.enter("tableDelimiterFiller");
      return headDelimiterFiller(code2);
    }
    return headDelimiterNok(code2);
  }
  function headDelimiterFiller(code2) {
    if (code2 === 45) {
      effects.consume(code2);
      return headDelimiterFiller;
    }
    if (code2 === 58) {
      seen = true;
      effects.exit("tableDelimiterFiller");
      effects.enter("tableDelimiterMarker");
      effects.consume(code2);
      effects.exit("tableDelimiterMarker");
      return headDelimiterRightAlignmentAfter;
    }
    effects.exit("tableDelimiterFiller");
    return headDelimiterRightAlignmentAfter(code2);
  }
  function headDelimiterRightAlignmentAfter(code2) {
    if (markdownSpace(code2)) {
      return factorySpace(effects, headDelimiterCellAfter, "whitespace")(code2);
    }
    return headDelimiterCellAfter(code2);
  }
  function headDelimiterCellAfter(code2) {
    if (code2 === 124) {
      return headDelimiterBefore(code2);
    }
    if (code2 === null || markdownLineEnding(code2)) {
      if (!seen || size !== sizeB) {
        return headDelimiterNok(code2);
      }
      effects.exit("tableDelimiterRow");
      effects.exit("tableHead");
      return ok3(code2);
    }
    return headDelimiterNok(code2);
  }
  function headDelimiterNok(code2) {
    return nok(code2);
  }
  function bodyRowStart(code2) {
    effects.enter("tableRow");
    return bodyRowBreak(code2);
  }
  function bodyRowBreak(code2) {
    if (code2 === 124) {
      effects.enter("tableCellDivider");
      effects.consume(code2);
      effects.exit("tableCellDivider");
      return bodyRowBreak;
    }
    if (code2 === null || markdownLineEnding(code2)) {
      effects.exit("tableRow");
      return ok3(code2);
    }
    if (markdownSpace(code2)) {
      return factorySpace(effects, bodyRowBreak, "whitespace")(code2);
    }
    effects.enter("data");
    return bodyRowData(code2);
  }
  function bodyRowData(code2) {
    if (code2 === null || code2 === 124 || markdownLineEndingOrSpace(code2)) {
      effects.exit("data");
      return bodyRowBreak(code2);
    }
    effects.consume(code2);
    return code2 === 92 ? bodyRowEscape : bodyRowData;
  }
  function bodyRowEscape(code2) {
    if (code2 === 92 || code2 === 124) {
      effects.consume(code2);
      return bodyRowData;
    }
    return bodyRowData(code2);
  }
}
function resolveTable(events, context) {
  let index2 = -1;
  let inFirstCellAwaitingPipe = true;
  let rowKind = 0;
  let lastCell = [0, 0, 0, 0];
  let cell2 = [0, 0, 0, 0];
  let afterHeadAwaitingFirstBodyRow = false;
  let lastTableEnd = 0;
  let currentTable;
  let currentBody;
  let currentCell;
  const map = new EditMap2();
  while (++index2 < events.length) {
    const event = events[index2];
    const token = event[1];
    if (event[0] === "enter") {
      if (token.type === "tableHead") {
        afterHeadAwaitingFirstBodyRow = false;
        if (lastTableEnd !== 0) {
          flushTableEnd(map, context, lastTableEnd, currentTable, currentBody);
          currentBody = void 0;
          lastTableEnd = 0;
        }
        currentTable = {
          type: "table",
          start: Object.assign({}, token.start),
          // Note: correct end is set later.
          end: Object.assign({}, token.end)
        };
        map.add(index2, 0, [["enter", currentTable, context]]);
      } else if (token.type === "tableRow" || token.type === "tableDelimiterRow") {
        inFirstCellAwaitingPipe = true;
        currentCell = void 0;
        lastCell = [0, 0, 0, 0];
        cell2 = [0, index2 + 1, 0, 0];
        if (afterHeadAwaitingFirstBodyRow) {
          afterHeadAwaitingFirstBodyRow = false;
          currentBody = {
            type: "tableBody",
            start: Object.assign({}, token.start),
            // Note: correct end is set later.
            end: Object.assign({}, token.end)
          };
          map.add(index2, 0, [["enter", currentBody, context]]);
        }
        rowKind = token.type === "tableDelimiterRow" ? 2 : currentBody ? 3 : 1;
      } else if (rowKind && (token.type === "data" || token.type === "tableDelimiterMarker" || token.type === "tableDelimiterFiller")) {
        inFirstCellAwaitingPipe = false;
        if (cell2[2] === 0) {
          if (lastCell[1] !== 0) {
            cell2[0] = cell2[1];
            currentCell = flushCell(map, context, lastCell, rowKind, void 0, currentCell);
            lastCell = [0, 0, 0, 0];
          }
          cell2[2] = index2;
        }
      } else if (token.type === "tableCellDivider") {
        if (inFirstCellAwaitingPipe) {
          inFirstCellAwaitingPipe = false;
        } else {
          if (lastCell[1] !== 0) {
            cell2[0] = cell2[1];
            currentCell = flushCell(map, context, lastCell, rowKind, void 0, currentCell);
          }
          lastCell = cell2;
          cell2 = [lastCell[1], index2, 0, 0];
        }
      }
    } else if (token.type === "tableHead") {
      afterHeadAwaitingFirstBodyRow = true;
      lastTableEnd = index2;
    } else if (token.type === "tableRow" || token.type === "tableDelimiterRow") {
      lastTableEnd = index2;
      if (lastCell[1] !== 0) {
        cell2[0] = cell2[1];
        currentCell = flushCell(map, context, lastCell, rowKind, index2, currentCell);
      } else if (cell2[1] !== 0) {
        currentCell = flushCell(map, context, cell2, rowKind, index2, currentCell);
      }
      rowKind = 0;
    } else if (rowKind && (token.type === "data" || token.type === "tableDelimiterMarker" || token.type === "tableDelimiterFiller")) {
      cell2[3] = index2;
    }
  }
  if (lastTableEnd !== 0) {
    flushTableEnd(map, context, lastTableEnd, currentTable, currentBody);
  }
  map.consume(context.events);
  index2 = -1;
  while (++index2 < context.events.length) {
    const event = context.events[index2];
    if (event[0] === "enter" && event[1].type === "table") {
      event[1]._align = gfmTableAlign(context.events, index2);
    }
  }
  return events;
}
function flushCell(map, context, range, rowKind, rowEnd, previousCell) {
  const groupName = rowKind === 1 ? "tableHeader" : rowKind === 2 ? "tableDelimiter" : "tableData";
  const valueName = "tableContent";
  if (range[0] !== 0) {
    previousCell.end = Object.assign({}, getPoint(context.events, range[0]));
    map.add(range[0], 0, [["exit", previousCell, context]]);
  }
  const now = getPoint(context.events, range[1]);
  previousCell = {
    type: groupName,
    start: Object.assign({}, now),
    // Note: correct end is set later.
    end: Object.assign({}, now)
  };
  map.add(range[1], 0, [["enter", previousCell, context]]);
  if (range[2] !== 0) {
    const relatedStart = getPoint(context.events, range[2]);
    const relatedEnd = getPoint(context.events, range[3]);
    const valueToken = {
      type: valueName,
      start: Object.assign({}, relatedStart),
      end: Object.assign({}, relatedEnd)
    };
    map.add(range[2], 0, [["enter", valueToken, context]]);
    if (rowKind !== 2) {
      const start2 = context.events[range[2]];
      const end2 = context.events[range[3]];
      start2[1].end = Object.assign({}, end2[1].end);
      start2[1].type = "chunkText";
      start2[1].contentType = "text";
      if (range[3] > range[2] + 1) {
        const a = range[2] + 1;
        const b = range[3] - range[2] - 1;
        map.add(a, b, []);
      }
    }
    map.add(range[3] + 1, 0, [["exit", valueToken, context]]);
  }
  if (rowEnd !== void 0) {
    previousCell.end = Object.assign({}, getPoint(context.events, rowEnd));
    map.add(rowEnd, 0, [["exit", previousCell, context]]);
    previousCell = void 0;
  }
  return previousCell;
}
function flushTableEnd(map, context, index2, table, tableBody) {
  const exits = [];
  const related = getPoint(context.events, index2);
  if (tableBody) {
    tableBody.end = Object.assign({}, related);
    exits.push(["exit", tableBody, context]);
  }
  table.end = Object.assign({}, related);
  exits.push(["exit", table, context]);
  map.add(index2 + 1, 0, exits);
}
function getPoint(events, index2) {
  const event = events[index2];
  const side = event[0] === "enter" ? "start" : "end";
  return event[1][side];
}

// node_modules/micromark-extension-gfm-task-list-item/lib/syntax.js
var tasklistCheck = {
  name: "tasklistCheck",
  tokenize: tokenizeTasklistCheck
};
function gfmTaskListItem() {
  return {
    text: {
      [91]: tasklistCheck
    }
  };
}
function tokenizeTasklistCheck(effects, ok3, nok) {
  const self = this;
  return open;
  function open(code2) {
    if (
      // Exit if there’s stuff before.
      self.previous !== null || // Exit if not in the first content that is the first child of a list
      // item.
      !self._gfmTasklistFirstContentOfListItem
    ) {
      return nok(code2);
    }
    effects.enter("taskListCheck");
    effects.enter("taskListCheckMarker");
    effects.consume(code2);
    effects.exit("taskListCheckMarker");
    return inside;
  }
  function inside(code2) {
    if (markdownLineEndingOrSpace(code2)) {
      effects.enter("taskListCheckValueUnchecked");
      effects.consume(code2);
      effects.exit("taskListCheckValueUnchecked");
      return close;
    }
    if (code2 === 88 || code2 === 120) {
      effects.enter("taskListCheckValueChecked");
      effects.consume(code2);
      effects.exit("taskListCheckValueChecked");
      return close;
    }
    return nok(code2);
  }
  function close(code2) {
    if (code2 === 93) {
      effects.enter("taskListCheckMarker");
      effects.consume(code2);
      effects.exit("taskListCheckMarker");
      effects.exit("taskListCheck");
      return after;
    }
    return nok(code2);
  }
  function after(code2) {
    if (markdownLineEnding(code2)) {
      return ok3(code2);
    }
    if (markdownSpace(code2)) {
      return effects.check({
        tokenize: spaceThenNonSpace
      }, ok3, nok)(code2);
    }
    return nok(code2);
  }
}
function spaceThenNonSpace(effects, ok3, nok) {
  return factorySpace(effects, after, "whitespace");
  function after(code2) {
    return code2 === null ? nok(code2) : ok3(code2);
  }
}

// node_modules/micromark-extension-gfm/index.js
function gfm(options) {
  return combineExtensions([
    gfmAutolinkLiteral(),
    gfmFootnote(),
    gfmStrikethrough(options),
    gfmTable(),
    gfmTaskListItem()
  ]);
}

// src/format/markdown.ts
import { posix } from "node:path";
var BOM = "\uFEFF";
var FRONT_MATTER = /^---[ \t]*\r?\n(?:[^\n]*\n)*?---[ \t]*(?:\r?\n|$)/;
var LEADING_BLANK_LINES = /^(?:[ \t]*\r?\n)+/;
function splitFile(text4) {
  const bom = text4.startsWith(BOM) ? BOM : "";
  const rest = text4.slice(bom.length);
  const match = FRONT_MATTER.exec(rest);
  if (!match) return { head: bom, body: rest };
  const afterBlock = rest.slice(match[0].length);
  const blank = LEADING_BLANK_LINES.exec(afterBlock)?.[0] ?? "";
  return { head: bom + match[0] + blank, body: afterBlock.slice(blank.length) };
}
function lineCount(text4) {
  let count4 = 0;
  for (const char of text4) if (char === "\n") count4++;
  return count4;
}
function parse2(body2) {
  return fromMarkdown(body2, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] });
}
function sameMarkdown(a, b) {
  if (a === b) return true;
  return isDeepStrictEqual(comparable(a), comparable(b));
}
var LINEAR_SYNTAX_ESCAPES = { "\\$": "\uE000", "\\+": "\uE001" };
function comparable(body2) {
  const marked = body2.replace(/\\[$+]/g, (escape) => LINEAR_SYNTAX_ESCAPES[escape]).replace(/^([ \t>]*(?:[*+-]|\d{1,9}[.)])(?:[ \t]+\[[ xX]\])?)[ \t]*$/gm, "$1 \uE002");
  const tree = parse2(marked);
  const strip = (node2) => {
    const { position: _position, ...rest } = node2;
    if ("url" in rest) rest.url = normalizeUri(rest.url);
    if ("children" in node2) return { ...rest, children: node2.children.map(strip) };
    return rest;
  };
  return strip(tree);
}
function start(node2) {
  return node2.position?.start.offset ?? 0;
}
function end(node2) {
  return node2.position?.end.offset ?? 0;
}
function line(node2) {
  return node2.position?.start.line ?? 1;
}
function visit(node2, enter, ancestors = []) {
  enter(node2, ancestors);
  if ("children" in node2) {
    ancestors.push(node2);
    for (const child of node2.children) visit(child, enter, ancestors);
    ancestors.pop();
  }
}
function resolveTarget(documentPath2, url) {
  if (url === "" || url.startsWith("#") || url.startsWith("/") || /^[a-z][a-z0-9+.-]*:/i.test(url)) return null;
  const cut = url.search(/[?#]/);
  let path2 = cut === -1 ? url : url.slice(0, cut);
  try {
    path2 = decodeURIComponent(path2);
  } catch {
  }
  if (path2 === "") return null;
  const joined = posix.normalize(posix.join(posix.dirname(documentPath2), path2));
  if (joined === "." || joined === ".." || joined.startsWith("../") || joined.endsWith("/")) return null;
  return joined;
}

// src/format/lint.ts
var GIT_MARKER = /^ {0,3}(?:<{7}|>{7})(?: |$)/;
var QUOTE_PREFIX = /^ {0,3}> ?/;
var URL_OR_LINK_ATTRIBUTE = /[a-z][a-z0-9+.-]*:\/\/|\b(?:src|href)\s*=/i;
function lintText(file, text4) {
  const { head, body: body2 } = splitFile(text4);
  const offset = lineCount(head);
  const findings = [];
  const report = (rule, bodyLine) => {
    if (findings.some((f) => f.rule === rule && f.line === bodyLine + offset)) return;
    findings.push({ file, line: bodyLine + offset, rule, message: LINT_RULES[rule] });
  };
  const content4 = body2.replace(/\r\n?/g, "\n");
  if ([...content4].length > CONTENT_LIMIT) report("content-too-long", 1);
  const tree = parse2(content4);
  lintTree(tree, content4, report);
  return findings.sort((a, b) => a.line - b.line || a.rule.localeCompare(b.rule));
}
function lintTree(tree, body2, report) {
  const definitions = /* @__PURE__ */ new Map();
  visit(tree, (node2) => {
    if (node2.type === "definition") definitions.set(node2.identifier, node2);
  });
  const codeLines = /* @__PURE__ */ new Set();
  visit(tree, (node2, ancestors) => {
    switch (node2.type) {
      case "code":
      case "inlineCode":
        for (let at = line(node2); at <= (node2.position?.end.line ?? at); at++) codeLines.add(at);
        if (node2.type === "inlineCode" && ancestors.some((a) => a.type === "emphasis" || a.type === "strong" || a.type === "delete")) {
          report("code-in-emphasis", line(node2));
        }
        break;
      case "footnoteReference":
      case "footnoteDefinition":
        report("footnote", line(node2));
        break;
      case "delete":
        if (!body2.startsWith("~~", start(node2))) report("subscript", line(node2));
        break;
      case "break":
        if (body2[start(node2)] === "\\") report("hard-break-backslash", line(node2));
        break;
      case "listItem": {
        const [first] = node2.children;
        if (first !== void 0 && first.type !== "paragraph") report("block-first-in-list-item", line(first));
        break;
      }
      case "table":
        if (node2.align?.some((align) => align !== null)) report("table-alignment", line(node2));
        break;
      case "text":
        if (ancestors.some((a) => a.type === "tableCell") && body2.slice(start(node2), end(node2)).includes("\\|")) {
          report("table-escaped-pipe", line(node2));
        }
        if (body2.slice(start(node2), end(node2)).includes("^[")) report("footnote", line(node2));
        break;
      case "link":
        if (node2.title) report("link-title", line(node2));
        if (node2.children.some((child) => child.type === "image" || child.type === "imageReference")) report("image-in-link", line(node2));
        break;
      case "linkReference": {
        const definition2 = definitions.get(node2.identifier);
        if (definition2?.title) report("link-title", line(node2));
        if (node2.children.some((child) => child.type === "image" || child.type === "imageReference")) report("image-in-link", line(node2));
        break;
      }
      case "image":
        if (node2.title) report("image-title", line(node2));
        break;
      case "imageReference":
        if (definitions.get(node2.identifier)?.title) report("image-title", line(node2));
        break;
      case "html":
        if (URL_OR_LINK_ATTRIBUTE.test(node2.value)) report("url-in-html", line(node2));
        break;
      default:
        break;
    }
  });
  body2.split("\n").forEach((text4, index2) => {
    if (codeLines.has(index2 + 1)) return;
    for (let rest = text4; ; ) {
      if (GIT_MARKER.test(rest)) {
        report("git-conflict-marker", index2 + 1);
        return;
      }
      const prefix = QUOTE_PREFIX.exec(rest);
      if (!prefix) return;
      rest = rest.slice(prefix[0].length);
    }
  });
}
function duplicateTitles(files) {
  const groups = /* @__PURE__ */ new Map();
  for (const file of files) {
    const key = file.replace(/\.md$/i, "").normalize("NFC").toUpperCase().toLowerCase();
    groups.set(key, [...groups.get(key) ?? [], file]);
  }
  return [...groups.values()].filter((group) => group.length > 1).flatMap((group) => group.map((file) => ({ file, line: 1, rule: "duplicate-title", message: `${LINT_RULES["duplicate-title"]} (${group.filter((other) => other !== file).join(", ")})` })));
}

// src/format/fix.ts
function linkedFileCheck(documentPath2, isFile) {
  return (url) => {
    const target = resolveTarget(documentPath2, url);
    return target !== null && isFile(target);
  };
}
function fixText(text4, options = {}) {
  if (lintText("", text4).length > 0) return text4;
  const { head, body: body2 } = splitFile(text4);
  const fixed = fixBody(body2.replace(/\r\n?/g, "\n"), options);
  return head + fixed;
}
function fixBody(body2, options) {
  if (body2.trim() === "") return "";
  let current = body2;
  for (let pass = 0; pass < 5; pass++) {
    const next = new Writer(current, parse2(current), options).root();
    if (next === current) return next;
    current = next;
  }
  return current;
}
var BLOCK_START = /^(?:[>#*+\-=_`~|]|\d{1,9}[.)])/;
var Writer = class {
  definitions = /* @__PURE__ */ new Map();
  containers = [];
  source;
  tree;
  options;
  constructor(source, tree, options) {
    this.source = source;
    this.tree = tree;
    this.options = options;
    visit(tree, (node2) => {
      if (node2.type === "definition" && !this.definitions.has(node2.identifier)) this.definitions.set(node2.identifier, node2);
    });
  }
  root() {
    return this.blocks(this.tree.children);
  }
  /** Sibling blocks, one blank line apart. Reference definitions are written inline instead. */
  blocks(nodes) {
    return nodes.filter((node2) => node2.type !== "definition").flatMap((node2) => this.block(node2)).join("\n\n");
  }
  block(node2) {
    switch (node2.type) {
      case "paragraph":
        return this.paragraph(node2);
      case "heading":
        return [`${"#".repeat(node2.depth)} ${this.inline(node2.children).replace(/[ \t]*\n[ \t]*/g, " ")}`.trimEnd()];
      case "thematicBreak":
        return ["---"];
      case "blockquote": {
        this.containers.push({ kind: "quote" });
        const content4 = this.blocks(node2.children);
        this.containers.pop();
        return [prefixLines(content4, "> ", ">")];
      }
      case "list":
        return [this.list(node2)];
      case "code": {
        const info = [node2.lang, node2.meta].filter(Boolean).join(" ");
        const mark2 = info.includes("`") ? "~" : "`";
        const longest = Math.max(0, ...[...node2.value.matchAll(mark2 === "`" ? /`+/g : /~+/g)].map((m) => m[0].length));
        const fence = mark2.repeat(Math.max(3, longest + 1));
        return [`${fence}${info}
${node2.value}${node2.value === "" ? "" : "\n"}${fence}`];
      }
      case "html":
        return [node2.value];
      case "table":
        return [this.table(node2)];
      default:
        return [this.source.slice(start(node2), end(node2))];
    }
  }
  /** A paragraph; `$$` math becomes a `math` fence, and an image shares no paragraph with text. */
  paragraph(node2) {
    const raw = this.source.slice(start(node2), end(node2));
    const math = /^\$\$\n([\s\S]*)\n\$\$$/.exec(raw);
    if (math) return [`\`\`\`math
${math[1]}
\`\`\``];
    const isImage = (child) => child.type === "image" || child.type === "imageReference";
    const images = node2.children.filter(isImage).length;
    const hasText = node2.children.some((child) => !isImage(child) && !(child.type === "text" && child.value.trim() === ""));
    if (images === 0 || !hasText && images === 1) return [this.inline(node2.children)];
    const parts = [[]];
    for (const child of node2.children) {
      if (isImage(child)) parts.push([child], []);
      else parts.at(-1).push(child);
    }
    return parts.map((part) => this.inline(part).trim()).filter((part) => part !== "");
  }
  list(node2) {
    return node2.children.map((item, index2) => {
      const marker = item.checked !== null && item.checked !== void 0 ? `- [${item.checked ? "X" : " "}]` : node2.ordered ? `${(node2.start ?? 1) + index2}.` : "*";
      return this.listItem(item, marker);
    }).join("\n");
  }
  listItem(item, marker) {
    const indent2 = " ".repeat(marker.split(" ")[0].length + 1);
    const [first] = item.children;
    const attachment = first?.type === "paragraph" && item.children.length === 1 ? attachmentLink(first) : void 0;
    if (attachment && this.options.linkedFileExists?.(attachment.url) !== false) {
      const label = this.inline(attachment.children);
      const destination2 = imageDestination(attachment.url);
      if (marker === "*" && VIDEO.test(attachment.url.split(/[?#]/)[0])) return `${marker} [${label}](${destination2})`;
      return `${marker} 
${indent2}[${label}](${destination2})`;
    }
    if (first === void 0) return marker;
    this.containers.push({ kind: "item", indent: (first.position?.start.column ?? 1) - (item.position?.start.column ?? 1) });
    let content4 = "";
    item.children.forEach((child, index2) => {
      if (index2 > 0) content4 += child.type === "list" && item.children[index2 - 1]?.type === "paragraph" ? "\n" : "\n\n";
      content4 += this.block(child).join("\n\n");
    });
    this.containers.pop();
    return `${marker} ${prefixLines(content4, indent2, "").slice(indent2.length)}`;
  }
  table(node2) {
    const width = node2.children[0]?.children.length ?? 0;
    const row = (cells, isHeader) => {
      const texts = Array.from({ length: width }, (_, index2) => {
        const cell2 = cells.children[index2];
        const text4 = cell2 ? this.inline(cell2.children).trim() : "";
        return isHeader && text4 === "#" ? "\\#" : text4;
      });
      return `| ${texts.join(" | ")} |`;
    };
    const [header, ...rows] = node2.children;
    if (!header) return "";
    return [row(header, true), `| ${Array.from({ length: width }, () => "--").join(" | ")} |`, ...rows.map((cells) => row(cells, false))].join("\n");
  }
  /**
   * Inline content copied from the source with targeted rewrites. The line
   * prefixes of the containers (quote markers, list indentation) are dropped,
   * since the caller writes its own, and so is the insignificant indentation
   * of continuation lines outside code spans.
   */
  inline(children) {
    if (children.length === 0) return "";
    const from = start(children[0]);
    const to = end(children.at(-1));
    const edits = [];
    for (const child of children) this.inlineEdits(child, edits);
    const code2 = [];
    for (const child of children) {
      visit(child, (node2) => {
        if (node2.type === "inlineCode") code2.push([start(node2), end(node2)]);
      });
    }
    for (let at2 = this.source.indexOf("\n", from); at2 !== -1 && at2 < to; at2 = this.source.indexOf("\n", at2 + 1)) {
      edits.push(this.continuation(at2 + 1, code2.some(([a, b]) => a <= at2 && at2 < b)));
    }
    let out = "";
    let at = from;
    for (const edit of edits.sort((a, b) => a.from - b.from)) {
      if (edit.from < at) continue;
      out += this.source.slice(at, edit.from) + edit.text;
      at = edit.to;
    }
    out += this.source.slice(at, to);
    return out;
  }
  /** The edit that removes a continuation line's container prefixes, starting at `lineStart`. */
  continuation(lineStart, inCode) {
    let at = lineStart;
    const line2 = this.source.slice(lineStart, this.source.indexOf("\n", lineStart) === -1 ? void 0 : this.source.indexOf("\n", lineStart));
    for (const container of this.containers) {
      const rest = this.source.slice(at, lineStart + line2.length);
      const prefix = container.kind === "quote" ? /^ {0,3}> ?/.exec(rest) : new RegExp(`^ {0,${container.indent}}`).exec(rest);
      if (!prefix) break;
      at += prefix[0].length;
    }
    if (!inCode) {
      const rest = this.source.slice(at, lineStart + line2.length);
      const space = /^[ \t]*/.exec(rest)[0];
      if (!BLOCK_START.test(rest.slice(space.length)) || space.length === 0) at += space.length;
    }
    return { from: lineStart, to: at, text: "" };
  }
  inlineEdits(node2, edits) {
    const from = start(node2);
    const to = end(node2);
    switch (node2.type) {
      case "emphasis":
      case "strong": {
        const width = node2.type === "strong" ? 2 : 1;
        if (this.source[from] === "_") {
          const mark2 = "*".repeat(width);
          edits.push({ from, to: from + width, text: mark2 }, { from: to - width, to, text: mark2 });
        }
        for (const child of node2.children) this.inlineEdits(child, edits);
        return;
      }
      case "delete":
        for (const child of node2.children) this.inlineEdits(child, edits);
        return;
      case "link":
        edits.push({ from, to, text: this.link(node2.children, node2.url) });
        return;
      case "linkReference": {
        const definition2 = this.definitions.get(node2.identifier);
        if (definition2) edits.push({ from, to, text: this.link(node2.children, definition2.url) });
        return;
      }
      case "image":
        edits.push({ from, to, text: `![${this.label(from + 1)}](${imageDestination(node2.url)})` });
        return;
      case "imageReference": {
        const definition2 = this.definitions.get(node2.identifier);
        if (definition2) edits.push({ from, to, text: `![${this.label(from + 1)}](${imageDestination(definition2.url)})` });
        return;
      }
      case "text":
        edits.push(...textEdits(this.source, from, to));
        return;
      default:
        return;
    }
  }
  /** Linear writes every link destination in angle brackets, without a title. */
  link(children, url) {
    return `[${this.inline(children)}](<${destination(url).replace(/</g, "%3C").replace(/>/g, "%3E")}>)`;
  }
  /** The bracketed label that opens at `open` (a `[`), as written, without its brackets. */
  label(open) {
    let depth2 = 0;
    for (let at = open; at < this.source.length; at++) {
      const char = this.source[at];
      if (char === "\\") at++;
      else if (char === "[") depth2++;
      else if (char === "]" && --depth2 === 0) return this.source.slice(open + 1, at);
    }
    return "";
  }
};
function textEdits(source, from, to) {
  const edits = [];
  const raw = source.slice(from, to);
  for (const match of raw.matchAll(/&(?:#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6}|[A-Za-z][A-Za-z0-9]{1,31});/g)) {
    const char = decodeEntity(match[0]);
    const after = raw.slice(match.index + match[0].length);
    if (char === void 0 || char.trim() === "") continue;
    if (char === "&" ? /^[A-Za-z0-9#]+;/.test(after) : char.codePointAt(0) < 128) continue;
    edits.push({ from: from + match.index, to: from + match.index + match[0].length, text: char });
  }
  for (const match of raw.matchAll(/:([a-z0-9_+-]+):/g)) {
    const emoji = Object.hasOwn(nameToEmoji, match[1]) ? nameToEmoji[match[1]] : void 0;
    if (emoji) edits.push({ from: from + match.index, to: from + match.index + match[0].length, text: emoji });
  }
  for (const match of raw.matchAll(/\\(.)/g)) {
    const at = from + match.index;
    const next = match[1];
    if (/[!-/:-@[-`{-~]/.test(next)) {
      if (next === "#" && insideLine(source, at)) edits.push({ from: at, to: at + 1, text: "" });
    } else {
      edits.push({ from: at, to: at + 1, text: "\\\\" });
    }
  }
  return edits;
}
function decodeEntity(reference) {
  const name = reference.slice(1, -1);
  if (!name.startsWith("#")) {
    const decoded = decodeNamedCharacterReference(name);
    return decoded === false ? void 0 : decoded;
  }
  const code2 = name[1] === "x" || name[1] === "X" ? Number.parseInt(name.slice(2), 16) : Number.parseInt(name.slice(1), 10);
  if (code2 === 0 || code2 > 1114111 || code2 >= 55296 && code2 <= 57343) return void 0;
  return String.fromCodePoint(code2);
}
function insideLine(source, at) {
  const lineStart = source.lastIndexOf("\n", at - 1) + 1;
  const lineEnd = source.indexOf("\n", at) === -1 ? source.length : source.indexOf("\n", at);
  const before = source.slice(lineStart, at).replace(/^(?:[ \t]*(?:>|[*+-](?=[ \t])|\d{1,9}[.)](?=[ \t])))*[ \t]*/, "");
  const after = source.slice(at + 2, lineEnd);
  return before !== "" && !/^[ \t#]*$/.test(after);
}
function destination(url) {
  return url.replace(/ /g, "%20").replace(/\\(?=[!-/:-@[-`{-~])/g, "\\\\").replace(/&(?=#[0-9]{1,7};|#[xX][0-9a-fA-F]{1,6};|[A-Za-z][A-Za-z0-9]{1,31};)/g, "&amp;");
}
function imageDestination(url) {
  return destination(url).replace(/[<>()]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}
function relativeLinkUrls(text4) {
  const urls = /* @__PURE__ */ new Set();
  visit(parse2(splitFile(text4).body), (node2) => {
    if (node2.type === "link" && !/^[a-z][a-z0-9+.-]*:/i.test(node2.url) && !node2.url.startsWith("#")) urls.add(node2.url);
  });
  return urls;
}
var VIDEO = /\.(?:mp4|mov|webm)$/i;
function attachmentLink(paragraph) {
  const [only] = paragraph.children;
  if (paragraph.children.length !== 1 || only?.type !== "link") return void 0;
  const url = only.url.split("#")[0];
  if (/^[a-z][a-z0-9+.-]*:/i.test(url) || url.startsWith("#") || /\.md$/i.test(url) || url === "") return void 0;
  return only;
}
function prefixLines(text4, prefix, empty2) {
  return text4.split("\n").map((line2) => line2 === "" ? empty2 : prefix + line2).join("\n");
}

// src/format/command.ts
var SKIPPED_FOLDERS = /* @__PURE__ */ new Set([".git", "node_modules"]);
var USAGE_ERROR = 2;
function markdownFiles(paths, cwd = process.cwd()) {
  const found = /* @__PURE__ */ new Set();
  const walk = (absolute) => {
    const stat = lstatSync(absolute);
    if (stat.isDirectory()) {
      for (const name of readdirSync(absolute).sort()) {
        if (!SKIPPED_FOLDERS.has(name)) walk(join2(absolute, name));
      }
    } else if (stat.isFile() && absolute.endsWith(".md")) {
      found.add(relative(cwd, absolute).split(sep).join("/"));
    }
  };
  for (const path2 of paths.length > 0 ? paths : ["."]) walk(resolve(cwd, path2));
  return [...found].sort();
}
function badPaths(paths, cwd) {
  const option = paths.find((path2) => path2.startsWith("-"));
  if (option !== void 0) return `unknown option: ${option}`;
  const missing = paths.find((path2) => !existsSync(resolve(cwd, path2)));
  return missing === void 0 ? void 0 : `no such file or folder: ${missing}`;
}
function lintAll(files, cwd) {
  const findings = files.flatMap((file) => lintText(file, readFileSync(join2(cwd, file), "utf8")));
  return [...findings, ...duplicateTitles(files)];
}
function describe(findings) {
  return findings.map((finding) => `${finding.file}:${finding.line}: ${finding.rule}: ${finding.message}
`).join("");
}
function linkedFileResolver(file, root) {
  return linkedFileCheck(file.split(sep).join("/"), (path2) => isFileAt(join2(root, path2)));
}
function isFileAt(path2) {
  try {
    return statSync(path2, { throwIfNoEntry: false })?.isFile() === true;
  } catch {
    return false;
  }
}
function runLint(paths, cwd = process.cwd()) {
  const problem = badPaths(paths, cwd);
  if (problem !== void 0) return { exitCode: USAGE_ERROR, stdout: "", stderr: `${problem}
` };
  const files = markdownFiles(paths, cwd);
  const findings = lintAll(files, cwd);
  const failing = new Set(findings.map((finding) => finding.file));
  const unfixed = files.filter((file) => {
    if (failing.has(file)) return false;
    const text4 = readFileSync(join2(cwd, file), "utf8");
    return fixText(text4, { linkedFileExists: linkedFileResolver(file, cwd) }) !== text4;
  });
  const stdout = describe(findings) + unfixed.map((file) => `${file}: not in Linear's form; run fix
`).join("");
  return { exitCode: stdout === "" ? 0 : 1, stdout, stderr: "" };
}
function runFix(paths, cwd = process.cwd()) {
  const problem = badPaths(paths, cwd);
  if (problem !== void 0) return { exitCode: USAGE_ERROR, stdout: "", stderr: `${problem}
` };
  const files = markdownFiles(paths, cwd);
  const colliding = new Set(duplicateTitles(files).map((finding) => finding.file));
  const changed2 = [];
  for (const file of files) {
    if (colliding.has(file)) continue;
    const path2 = join2(cwd, file);
    const text4 = readFileSync(path2, "utf8");
    const fixed = fixText(text4, { linkedFileExists: linkedFileResolver(file, cwd) });
    if (fixed !== text4) {
      writeFileSync(path2, fixed);
      changed2.push(file);
    }
  }
  const findings = lintAll(files, cwd);
  const stdout = changed2.map((file) => `${file}: fixed
`).join("") + describe(findings);
  return { exitCode: stdout === "" ? 0 : 1, stdout, stderr: "" };
}

// src/version.ts
var PROJECT_URL = "https://github.com/mdbisync/mdbisync";
var VERSION2 = true ? "0.1.0-rc.5" : packageJson.version;

// src/setup/report.ts
function passed(name, detail) {
  return { name, state: "passed", detail };
}
function failed(name, code2, detail) {
  return { name, state: "failed", detail, code: code2 };
}
function notChecked(name, detail) {
  return { name, state: "not-checked", detail };
}
function buildReport(checks, securityHooks2) {
  const failure = checks.find((check) => check.state === "failed");
  return failure?.code === void 0 ? { ok: true, checks, securityHooks: securityHooks2 } : { ok: false, code: failure.code, detail: failure.detail, checks, securityHooks: securityHooks2 };
}

// src/setup/fixes.ts
var QUICKSTART_PATH = "docs/quickstart.md";
var QUICKSTART_URL = `${PROJECT_URL}/blob/main/${QUICKSTART_PATH}`;
var FIX_ANCHORS = {
  "linear-credential-failed": "linear-oauth-app",
  "linear-teams-not-visible": "linear-oauth-app",
  "github-credential-failed": "github-app",
  "missing-permission": "github-app",
  "merge-commits-required": "merge-commits",
  "linear-format-hook-required": "linear-format-hook",
  "invalid-annotation": "folder-annotations",
  "no-annotations": "folder-annotations",
  "annotation-target-not-found": "folder-annotations",
  "annotation-target-ambiguous": "folder-annotations",
  "annotation-target-shared": "folder-annotations",
  "initial-sync-required": "initial-sync",
  "initial-pull-request-pending": "initial-sync"
};
function fixUrl(code2) {
  if (code2 === void 0 || !Object.hasOwn(FIX_ANCHORS, code2)) return void 0;
  return `${QUICKSTART_URL}#${FIX_ANCHORS[code2]}`;
}

// src/sync/capture.ts
var import_yaml2 = __toESM(require_dist(), 1);
import { mkdtemp as mkdtemp4, rm as rm4 } from "node:fs/promises";
import { tmpdir as tmpdir4 } from "node:os";
import { join as join7, posix as posix7 } from "node:path";

// src/mapping/front-matter.ts
var import_yaml = __toESM(require_dist(), 1);
var OPENING_FENCE = /^﻿?---[ \t]*\r?\n/;
var CLOSING_FENCE = /^---[ \t]*(?:\r?\n|$)/m;
function findFrontMatter(text4) {
  const { head } = splitFile(text4);
  const opening = OPENING_FENCE.exec(head);
  if (opening === null) return null;
  const rest = head.slice(opening[0].length);
  const closing = CLOSING_FENCE.exec(rest);
  return closing === null ? null : { yaml: rest.slice(0, closing.index) };
}
function parseQuietly(yaml) {
  return (0, import_yaml.parse)(yaml, { logLevel: "error", prettyErrors: false });
}

// src/mapping/annotations.ts
var ANNOTATION_FILE = "README.md";
var TEAM_KEY = "linear-team";
var PROJECT_KEY = "linear-project";
var MENTIONS_KEY = new RegExp(`^[ \\t]*["']?(?:${TEAM_KEY}|${PROJECT_KEY})["']?[ \\t]*:`, "m");
function readAnnotation(readme, text4) {
  const folder = folderOf(readme);
  const frontMatter = findFrontMatter(text4);
  if (frontMatter === null) return { annotation: null };
  let data;
  try {
    data = parseQuietly(frontMatter.yaml);
  } catch {
    if (!MENTIONS_KEY.test(frontMatter.yaml)) return { annotation: null };
    return { problem: { readme, kind: "invalid-annotation", message: `${readme}: the front matter with ${TEAM_KEY} or ${PROJECT_KEY} is not valid YAML` } };
  }
  if (data === null || typeof data !== "object" || Array.isArray(data)) return { annotation: null };
  const annotation = { folder, readme };
  for (const [key, field] of [[TEAM_KEY, "team"], [PROJECT_KEY, "project"]]) {
    if (!Object.hasOwn(data, key)) continue;
    const value = data[key];
    if (typeof value !== "string" || value.trim() === "") {
      return { problem: { readme, kind: "invalid-annotation", message: `${readme}: ${key} must be a non-empty name` } };
    }
    annotation[field] = value.trim();
  }
  return { annotation: annotation.team === void 0 && annotation.project === void 0 ? null : annotation };
}
function resolveZones(annotations) {
  const zones = /* @__PURE__ */ new Map();
  const problems = [];
  const ordered = [...annotations].sort((a, b) => depth(a.folder) - depth(b.folder) || compare(a.folder, b.folder));
  for (const annotation of ordered) {
    const inherited = nearestZone(zones, parentOf(annotation.folder));
    const { readme } = annotation;
    if (annotation.team !== void 0 && inherited !== void 0) {
      problems.push({ readme, kind: "nested-team", message: `${readme}: names a team inside the folder of team "${inherited.team}" (${display(inherited.teamFolder)})` });
      continue;
    }
    if (annotation.project !== void 0 && inherited?.project !== void 0) {
      problems.push({
        readme,
        kind: "nested-project",
        message: `${readme}: names a project inside the folder of project "${inherited.project}" (${display(inherited.projectFolder ?? "")})`
      });
      continue;
    }
    if (annotation.team === void 0 && inherited === void 0) {
      problems.push({ readme, kind: "project-without-team", message: `${readme}: names a project, but neither it nor a folder above names a team` });
      continue;
    }
    const zone = annotation.team !== void 0 ? { team: annotation.team, teamFolder: annotation.folder } : { ...inherited };
    if (annotation.project !== void 0) {
      zone.project = annotation.project;
      zone.projectFolder = annotation.folder;
    }
    zones.set(annotation.folder, zone);
  }
  return { zones, problems };
}
function nearestZone(zones, folder) {
  for (let current = folder; current !== null; current = parentOf(current)) {
    const zone = zones.get(current);
    if (zone !== void 0) return zone;
  }
  return void 0;
}
function folderOf(path2) {
  const slash = path2.lastIndexOf("/");
  return slash === -1 ? "" : path2.slice(0, slash);
}
function parentOf(folder) {
  return folder === "" ? null : folderOf(folder);
}
function depth(folder) {
  return folder === "" ? 0 : folder.split("/").length;
}
function compare(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}
function display(folder) {
  return folder === "" ? "the repository root" : `${folder}/`;
}

// src/state/git.ts
import { spawn } from "node:child_process";
var GitError = class extends Error {
  args;
  code;
  stderr;
  constructor(args, code2, stderr) {
    super(`git ${args.join(" ")} failed with exit code ${code2}: ${stderr.trim()}`);
    this.name = "GitError";
    this.args = args;
    this.code = code2;
    this.stderr = stderr;
  }
};
var BASE_ENV = {
  GIT_TERMINAL_PROMPT: "0",
  GIT_LFS_SKIP_SMUDGE: "1",
  LC_ALL: "C"
};
var Git = class {
  dir;
  env;
  /**
   * @param dir a directory inside the repository (a working tree or a bare repository)
   * @param env environment added to every call
   */
  constructor(dir, env = {}) {
    this.dir = dir;
    this.env = env;
  }
  run(args, options = {}) {
    const env = options.onlyEnv !== void 0 ? { ...BASE_ENV, ...options.onlyEnv } : { ...process.env, ...BASE_ENV, ...this.env, ...options.env };
    for (const key of Object.keys(env)) {
      if (env[key] === void 0) delete env[key];
    }
    const okCodes = options.okCodes ?? [0];
    return new Promise((resolve3, reject) => {
      const child = spawn("git", args, { cwd: this.dir, env, stdio: ["pipe", "pipe", "pipe"] });
      const out = [];
      const err = [];
      child.stdout.on("data", (chunk) => out.push(chunk));
      child.stderr.on("data", (chunk) => err.push(chunk));
      child.on("error", reject);
      child.stdin.on("error", () => {
      });
      child.on("close", (code2) => {
        const result = {
          code: code2 ?? -1,
          stdout: Buffer.concat(out),
          stderr: Buffer.concat(err).toString("utf8")
        };
        if (okCodes.includes(result.code)) resolve3(result);
        else reject(new GitError(args, result.code, result.stderr));
      });
      child.stdin.end(options.input ?? "");
    });
  }
  /** Runs git and returns standard output as text without the final newline. */
  async text(args, options = {}) {
    const { stdout } = await this.run(args, options);
    return stdout.toString("utf8").replace(/\n$/, "");
  }
};
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index2 = next++;
      results[index2] = await fn(items[index2]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

// src/state/lfs.ts
import { createHash as createHash2 } from "node:crypto";
var POINTER_VERSION = "version https://git-lfs.github.com/spec/v1";
var MAX_POINTER_SIZE = 1024;
function parseLfsPointer(blob) {
  if (blob.length >= MAX_POINTER_SIZE || !blob.subarray(0, POINTER_VERSION.length).equals(Buffer.from(POINTER_VERSION))) {
    return null;
  }
  const text4 = blob.toString("utf8");
  if (!text4.endsWith("\n")) return null;
  const lines2 = text4.slice(0, -1).split("\n");
  if (lines2[0] !== POINTER_VERSION) return null;
  let oid = null;
  let size = null;
  let extensions = false;
  for (const line2 of lines2.slice(1)) {
    const space = line2.indexOf(" ");
    if (space <= 0) return null;
    const key = line2.slice(0, space);
    const value = line2.slice(space + 1);
    if (key === "oid") {
      const match = /^sha256:([0-9a-f]{64})$/.exec(value);
      if (match === null) return null;
      oid = match[1];
    } else if (key === "size") {
      if (!/^(0|[1-9][0-9]*)$/.test(value)) return null;
      size = Number(value);
    } else if (!/^[a-z0-9.-]+$/.test(key)) {
      return null;
    } else if (key.startsWith("ext-")) {
      extensions = true;
    }
  }
  return oid !== null && size !== null ? { oid, size, extensions } : null;
}
async function lfsReader(git, remote) {
  const remoteArgs = ["-c", `remote.lfsdefault=${remote}`];
  const branch = await git.run(["symbolic-ref", "--quiet", "--short", "HEAD"], { okCodes: [0, 1, 128] });
  if (branch.code === 0) remoteArgs.push("-c", `branch.${branch.stdout.toString("utf8").trim()}.remote=${remote}`);
  return (pointer, path2) => readLfsObject(git, remoteArgs, pointer, path2);
}
async function readLfsObject(git, remoteArgs, pointer, path2) {
  if (pointer.extensions) {
    return { ok: false, reason: `LFS object ${pointer.oid} uses LFS extensions, which are not supported` };
  }
  const pointerText = `${POINTER_VERSION}
oid sha256:${pointer.oid}
size ${pointer.size}
`;
  let content4;
  try {
    const result = await git.run([...remoteArgs, "lfs", "smudge", "--", path2], {
      input: pointerText,
      env: { GIT_LFS_SKIP_SMUDGE: void 0 }
    });
    content4 = result.stdout;
  } catch (error) {
    if (error instanceof GitError) {
      return { ok: false, reason: `LFS object ${pointer.oid} could not be read (exit code ${error.code})` };
    }
    throw error;
  }
  if (content4.length !== pointer.size || createHash2("sha256").update(content4).digest("hex") !== pointer.oid) {
    return { ok: false, reason: `LFS object ${pointer.oid} is missing or does not match its pointer` };
  }
  return { ok: true, content: content4 };
}

// src/state/objects.ts
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join as join3 } from "node:path";
async function listTree(git, treeish) {
  const { stdout } = await git.run(["ls-tree", "-r", "-z", "-l", "--full-tree", treeish]);
  const entries = [];
  for (const record of stdout.toString("utf8").split("\0")) {
    if (record === "") continue;
    const tab = record.indexOf("	");
    const [mode, type, oid, size] = record.slice(0, tab).split(/ +/);
    if (type !== "blob" && type !== "commit") continue;
    entries.push({
      path: record.slice(tab + 1),
      mode,
      type,
      oid,
      size: size === "-" || size === void 0 ? null : Number(size)
    });
  }
  return entries;
}
async function readBlobs(git, oids) {
  const unique = [...new Set(oids)];
  const result = /* @__PURE__ */ new Map();
  if (unique.length === 0) return result;
  const { stdout } = await git.run(["cat-file", "--batch"], { input: unique.join("\n") + "\n" });
  let offset = 0;
  for (const oid of unique) {
    const end2 = stdout.indexOf(10, offset);
    const header = stdout.subarray(offset, end2).toString("utf8");
    const [, type, size] = header.split(" ");
    if (type === "missing" || type === void 0 || size === void 0) {
      throw new Error(`git object ${oid} is missing`);
    }
    if (type !== "blob") throw new Error(`git object ${oid} is a ${type}, not a blob`);
    const start2 = end2 + 1;
    const length = Number(size);
    result.set(oid, stdout.subarray(start2, start2 + length));
    offset = start2 + length + 1;
  }
  return result;
}
async function writeBlob(git, content4) {
  return git.text(["hash-object", "-w", "--no-filters", "--stdin"], { input: content4 });
}
function checkRepoPath(path2) {
  const parts = path2.split("/");
  if (path2 === "" || path2.includes("\0") || path2.includes("\\")) throw new Error(`invalid repository path ${JSON.stringify(path2)}`);
  for (const part of parts) {
    if (part === "" || part === "." || part === ".." || part.toLowerCase() === ".git") {
      throw new Error(`invalid repository path ${JSON.stringify(path2)}`);
    }
  }
}
async function commitTree(git, spec) {
  for (const path2 of spec.changes.keys()) checkRepoPath(path2);
  const tree = await buildTree(git, spec.base, spec.changes);
  if ((spec.skipIfUnchanged ?? true) && spec.parents.length === 1) {
    const parentTree = await git.text(["rev-parse", `${spec.parents[0]}^{tree}`]);
    if (parentTree === tree) return spec.parents[0];
  }
  const args = ["commit-tree", "--no-gpg-sign", tree];
  for (const parent of spec.parents) args.push("-p", parent);
  args.push("-F", "-");
  return git.text(args, {
    input: spec.message.endsWith("\n") ? spec.message : `${spec.message}
`,
    env: {
      GIT_AUTHOR_NAME: spec.identity.name,
      GIT_AUTHOR_EMAIL: spec.identity.email,
      GIT_COMMITTER_NAME: spec.identity.name,
      GIT_COMMITTER_EMAIL: spec.identity.email
    }
  });
}
async function buildTree(git, base, changes) {
  const dir = await mkdtemp(join3(tmpdir(), "state-index-"));
  const env = { GIT_INDEX_FILE: join3(dir, "index") };
  try {
    if (base === null) await git.run(["read-tree", "--empty"], { env });
    else await git.run(["read-tree", `${base}^{tree}`], { env });
    const modes = base !== null && changes.size > 0 ? await listModes(git, base) : /* @__PURE__ */ new Map();
    const nullOid = "0".repeat(await git.text(["rev-parse", "--show-object-format"]) === "sha256" ? 64 : 40);
    const lines2 = await mapLimit([...changes.entries()], 8, async ([path2, content4]) => {
      if (content4 === null) return `0 ${nullOid}	${path2}\0`;
      const oid = await writeBlob(git, content4);
      const mode = modes.get(path2) === "100755" ? "100755" : "100644";
      return `${mode} ${oid}	${path2}\0`;
    });
    if (lines2.length > 0) await git.run(["update-index", "-z", "--index-info"], { input: lines2.join(""), env });
    return await git.text(["write-tree"], { env });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
async function listModes(git, treeish) {
  const { stdout } = await git.run(["ls-tree", "-r", "-z", "--full-tree", treeish]);
  const modes = /* @__PURE__ */ new Map();
  for (const record of stdout.toString("utf8").split("\0")) {
    const tab = record.indexOf("	");
    if (tab > 0) modes.set(record.slice(tab + 1), record.slice(0, record.indexOf(" ")));
  }
  return modes;
}

// src/mapping/mapping.ts
var MARKDOWN_EXTENSION = ".md";
function annotationFiles(entries) {
  return entries.filter((entry) => entry.type === "blob" && baseName(entry.path) === ANNOTATION_FILE);
}
function collectAnnotations(readmes) {
  const annotations = [];
  const problems = [];
  for (const [path2, text4] of readmes) {
    const result = readAnnotation(path2, text4);
    if ("problem" in result) problems.push(result.problem);
    else if (result.annotation !== null) annotations.push(result.annotation);
  }
  return { annotations, problems };
}
function candidateFiles(entries, zones) {
  return entries.filter((entry) => isMarkdown(entry) && isRegularFile(entry) && nearestZone(zones, folderOf(entry.path)) !== void 0);
}
function mapFiles(entries, zones, contents) {
  const mapped = [];
  const unsynced = [];
  for (const entry of entries) {
    if (!isMarkdown(entry)) continue;
    const zone = nearestZone(zones, folderOf(entry.path));
    if (zone === void 0) {
      unsynced.push({ path: entry.path, reason: "outside-annotations" });
      continue;
    }
    if (!isRegularFile(entry)) {
      unsynced.push({ path: entry.path, reason: "not-a-regular-file", title: titleOf(entry.path, zone), place: placeOf(zone) });
      continue;
    }
    const content4 = contents.get(entry.oid);
    if (content4 === void 0) throw new Error(`the content of ${entry.path} was not read`);
    const problem = contentProblem(content4);
    if (problem !== null) {
      unsynced.push({ path: entry.path, reason: problem, title: titleOf(entry.path, zone), place: placeOf(zone) });
      continue;
    }
    mapped.push({ path: entry.path, oid: entry.oid, title: titleOf(entry.path, zone), place: placeOf(zone) });
  }
  const { documents, leftOut } = separateCollisions(mapped);
  return { documents, unsynced, leftOut };
}
async function loadMapping(git, commit) {
  const entries = await listTree(git, commit);
  const readmeEntries = annotationFiles(entries);
  const readmeBlobs = await readBlobs(git, readmeEntries.map((entry) => entry.oid));
  const readmes = new Map(readmeEntries.map((entry) => [entry.path, readmeBlobs.get(entry.oid).toString("utf8")]));
  const { annotations, problems: readProblems } = collectAnnotations(readmes);
  const { zones, problems: zoneProblems } = resolveZones(annotations);
  const contents = await readBlobs(git, candidateFiles(entries, zones).map((entry) => entry.oid));
  return { annotations, zones, problems: [...readProblems, ...zoneProblems], ...mapFiles(entries, zones, contents) };
}
function titleKey(place, title) {
  const where = place.kind === "project" ? `project\0${place.team}\0${place.project}` : `team\0${place.team}`;
  return `${where}\0${title.normalize("NFC").toLowerCase()}`;
}
function separateCollisions(mapped) {
  const groups = /* @__PURE__ */ new Map();
  for (const document4 of mapped) {
    const key = titleKey(document4.place, document4.title);
    groups.set(key, [...groups.get(key) ?? [], document4]);
  }
  const documents = [];
  const leftOut = [];
  for (const group of groups.values()) {
    if (group.length === 1) {
      documents.push(group[0]);
      continue;
    }
    for (const document4 of group) {
      leftOut.push({
        path: document4.path,
        oid: document4.oid,
        rule: "duplicate-title",
        title: document4.title,
        place: document4.place,
        collidesWith: group.filter((other) => other !== document4).map((other) => other.path)
      });
    }
  }
  return { documents, leftOut };
}
function titleOf(path2, zone) {
  const base = zone.projectFolder ?? zone.teamFolder;
  const relative3 = base === "" ? path2 : path2.slice(base.length + 1);
  return relative3.slice(0, -MARKDOWN_EXTENSION.length);
}
function placeOf(zone) {
  return zone.project !== void 0 ? { kind: "project", team: zone.team, project: zone.project } : { kind: "team", team: zone.team };
}
var UTF8 = new TextDecoder("utf-8", { fatal: true });
function contentProblem(content4) {
  if (parseLfsPointer(content4) !== null) return "stored-in-lfs";
  if (content4.includes(0)) return "binary";
  try {
    UTF8.decode(content4);
  } catch {
    return "binary";
  }
  return null;
}
function isMarkdown(entry) {
  return entry.path.endsWith(MARKDOWN_EXTENSION) && entry.path.length > MARKDOWN_EXTENSION.length && !entry.path.endsWith(`/${MARKDOWN_EXTENSION}`);
}
function isRegularFile(entry) {
  return entry.type === "blob" && (entry.mode === "100644" || entry.mode === "100755");
}
function baseName(path2) {
  return path2.slice(path2.lastIndexOf("/") + 1);
}

// src/setup/linear.ts
import { setTimeout as setTimeout2 } from "node:timers/promises";
var REQUIRED_SCOPES = ["read", "write"];
var TEAM_REFS_PER_REQUEST = 125;
var TEAMS_RETRY_DELAY_MS = 3e3;
function projectKey(team, project) {
  return `${team}\0${project}`;
}
function isCredentialError(error) {
  if (error instanceof LinearTokenError) return error.credentialsRefused;
  if (error instanceof LinearGraphQLError) {
    return error.httpStatus === 401 || error.code === "AUTHENTICATION_ERROR";
  }
  return error instanceof LinearHttpError && error.httpStatus === 401;
}
function checkLinearScopes(scope) {
  if (scope === void 0) return passed("linear-credentials", "Linear token accepted");
  const missing = REQUIRED_SCOPES.filter((wanted) => !scope.includes(wanted));
  return missing.length === 0 ? passed("linear-credentials", `Linear token accepted with scopes ${scope.join(", ")}`) : failed("linear-credentials", "linear-credential-failed", `the Linear token lacks the scope ${missing.join(", ")}`);
}
function linearCredentialFailure(detail) {
  return failed("linear-credentials", "linear-credential-failed", detail);
}
async function resolveTargets(client, zones, retryDelayMs = TEAMS_RETRY_DELAY_MS) {
  const zoneList = [...zones];
  const teamRefs = /* @__PURE__ */ new Set();
  const projectRefs = /* @__PURE__ */ new Map();
  for (const zone of zoneList) {
    teamRefs.add(zone.team);
    if (zone.project !== void 0) projectRefs.set(projectKey(zone.team, zone.project), { team: zone.team, project: zone.project });
  }
  if (teamRefs.size === 0) return { result: notChecked("annotation-targets", "no annotated folders") };
  const refs = [...teamRefs];
  const names = [...new Set([...projectRefs.values()].map((ref) => ref.project))];
  const lookUp = async () => {
    const teamNodes2 = [];
    let projectNodes2 = [];
    let seesTeams;
    for (let start2 = 0; start2 < refs.length; start2 += TEAM_REFS_PER_REQUEST) {
      const batch = refs.slice(start2, start2 + TEAM_REFS_PER_REQUEST);
      const first = start2 === 0;
      const withProjects = first && names.length > 0;
      const data = await client.request(
        "SetupTargets",
        "query",
        `query SetupTargets($refs: [String!]!, $first: Int!${withProjects ? ", $names: [String!]!" : ""}) {
          teams(first: $first, filter: { or: [{ key: { in: $refs } }, { name: { in: $refs } }] }) { nodes { id key name } }
          ${withProjects ? "projects(first: 250, filter: { name: { in: $names } }) { nodes { id name teams(first: 50) { nodes { id } } } pageInfo { hasNextPage } }" : ""}
          ${first ? "visible: teams(first: 1) { nodes { id } }" : ""}
        }`,
        withProjects ? { refs: batch, first: batch.length * 2, names } : { refs: batch, first: batch.length * 2 }
      );
      teamNodes2.push(...data.teams.nodes.filter((team) => !teamNodes2.some((known) => known.id === team.id)));
      if (data.projects !== void 0) {
        if (data.projects.pageInfo.hasNextPage) throw new Error("more than 250 Linear projects share the annotated names");
        projectNodes2 = data.projects.nodes;
      }
      if (data.visible !== void 0) seesTeams = data.visible.nodes.length > 0;
    }
    return { teamNodes: teamNodes2, projectNodes: projectNodes2, seesTeams };
  };
  let teamNodes;
  let projectNodes;
  try {
    let found = await lookUp();
    if (found.seesTeams === false) {
      await setTimeout2(retryDelayMs);
      found = await lookUp();
      if (found.seesTeams === false) {
        return {
          result: failed(
            "annotation-targets",
            "linear-teams-not-visible",
            `the Linear app saw no team in two lookups, so none of the annotated teams (${[...refs].sort().map((ref) => `"${ref}"`).join(", ")}) can be found: check the app's team access in Linear`
          )
        };
      }
    }
    ({ teamNodes, projectNodes } = found);
  } catch (error) {
    if (!isCredentialError(error)) throw error;
    return {
      result: notChecked("annotation-targets", "needs working Linear credentials"),
      credentials: linearCredentialFailure("Linear refused the token while reading teams")
    };
  }
  const targets = { teams: /* @__PURE__ */ new Map(), projects: /* @__PURE__ */ new Map() };
  const missing = [];
  const ambiguous = [];
  for (const ref of [...teamRefs].sort()) {
    const matches = teamNodes.filter((team) => team.key === ref || team.name === ref);
    if (matches.length === 1) targets.teams.set(ref, matches[0]);
    else (matches.length === 0 ? missing : ambiguous).push(`team "${ref}"`);
  }
  for (const [key, ref] of [...projectRefs].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
    const team = targets.teams.get(ref.team);
    if (team === void 0) continue;
    const matches = projectNodes.filter((project) => project.name === ref.project && project.teams.nodes.some((node2) => node2.id === team.id));
    if (matches.length === 1) {
      const { id, name } = matches[0];
      targets.projects.set(key, { id, name });
    } else {
      (matches.length === 0 ? missing : ambiguous).push(`project "${ref.project}" of team "${ref.team}"`);
    }
  }
  if (missing.length > 0) {
    return { result: failed("annotation-targets", "annotation-target-not-found", `not found in Linear: ${missing.join(", ")}`) };
  }
  if (ambiguous.length > 0) {
    return { result: failed("annotation-targets", "annotation-target-ambiguous", `more than one match in Linear: ${ambiguous.join(", ")}`) };
  }
  const shared = sharedDestinations(zoneList, targets);
  if (shared.length > 0) {
    return { result: failed("annotation-targets", "annotation-target-shared", `more than one folder maps to ${shared.join("; ")}`) };
  }
  return {
    result: passed("annotation-targets", `found in Linear: ${targets.teams.size} teams, ${targets.projects.size} projects`),
    targets
  };
}
function sharedDestinations(zones, targets) {
  const folders = /* @__PURE__ */ new Map();
  for (const zone of zones) {
    const team = targets.teams.get(zone.team);
    const [id, label, folder] = zone.project === void 0 ? [`team\0${team.id}`, `the documents of team "${team.name}"`, zone.teamFolder] : [`project\0${targets.projects.get(projectKey(zone.team, zone.project)).id}`, `project "${zone.project}"`, zone.projectFolder];
    const entry = folders.get(id) ?? { label, folders: /* @__PURE__ */ new Set() };
    entry.folders.add(folder === "" ? "the repository root" : `${folder}/`);
    folders.set(id, entry);
  }
  return [...folders.values()].filter((entry) => entry.folders.size > 1).map((entry) => `${entry.label} (${[...entry.folders].sort().join(", ")})`);
}

// src/run/summary.ts
function placeLabel(place) {
  return place.kind === "project" ? `project "${place.project}" of team "${place.team}"` : `team "${place.team}"`;
}
function cell(text4) {
  return text4.replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/[\r\n]+/g, " ");
}

// src/setup/github.ts
var DEFAULT_GITHUB_API_URL = "https://api.github.com";
var PERMISSION_PROBES = [
  { permission: "contents:write", method: "POST", path: () => "/git/blobs", body: {} },
  { permission: "pull_requests:write", method: "POST", path: () => "/pulls", body: {} },
  // GitHub checks the workflows permission for this path first (403), and only
  // then rejects the update for its missing `content` (422); measured with
  // App tokens with and without the permission.
  {
    permission: "workflows:write",
    method: "PUT",
    path: () => "/contents/.github/workflows/setup-check.yml",
    body: { message: "setup check" },
    requires: "contents:write"
  },
  { permission: "checks:read", method: "GET", path: (commit) => `/commits/${commit}/check-runs?per_page=1` },
  { permission: "statuses:read", method: "GET", path: (commit) => `/commits/${commit}/statuses?per_page=1` }
];
async function checkGitHub(target) {
  const request2 = requester(target);
  const repository = await request2("GET", "");
  if (repository.status === 403 && isRateLimited2(repository)) {
    throw new Error("GitHub rate-limited the setup check while reading the repository (HTTP 403); run again later");
  }
  if (repository.status === 401 || repository.status === 403 || repository.status === 404) {
    const why = repository.status === 401 ? "was refused" : "cannot see the repository";
    const access2 = failed("github-access", "github-credential-failed", `the GitHub token ${why} (HTTP ${repository.status})`);
    return { access: access2, mergeCommits: notChecked("merge-commits", "needs a working GitHub token") };
  }
  ensureAnswered(repository.status, "reading the repository");
  const missing = [];
  const unknown = [];
  for (const probe of PERMISSION_PROBES) {
    if (probe.requires !== void 0 && missing.includes(probe.requires)) {
      unknown.push(probe.permission);
      continue;
    }
    const answer = await request2(probe.method, probe.path(target.commit), probe.body);
    const { status } = answer;
    if (status === 403 && isRateLimited2(answer)) {
      throw new Error(`GitHub rate-limited the setup check while checking ${probe.permission} (HTTP 403); run again later`);
    }
    if (status === 403) missing.push(probe.permission);
    else if (!(status >= 200 && status < 300) && status !== 422) {
      throw new Error(`GitHub answered HTTP ${status} while checking ${probe.permission}`);
    }
  }
  const access = missing.length === 0 ? passed("github-access", `GitHub token has ${PERMISSION_PROBES.map((probe) => probe.permission).join(", ")}`) : failed(
    "github-access",
    "missing-permission",
    `the GitHub token lacks ${missing.join(", ")}${unknown.length > 0 ? ` (${unknown.join(", ")} not checked without it)` : ""}`
  );
  const allow = repository.json?.allow_merge_commit;
  const mergeCommits = typeof allow !== "boolean" ? missing.includes("contents:write") ? notChecked("merge-commits", "needs contents:write to read the merge setting") : failed("merge-commits", "merge-commits-required", "GitHub did not show whether merge commits are allowed") : allow ? passed("merge-commits", "merge commits are allowed") : failed("merge-commits", "merge-commits-required", "merge commits are not allowed in the repository settings");
  return { access, mergeCommits };
}
function requester(target) {
  const base = `${(target.apiUrl ?? DEFAULT_GITHUB_API_URL).replace(/\/+$/, "")}/repos/${target.repository}`;
  const fetchImpl = target.fetch ?? fetch;
  return async (method, path2, body2) => {
    const response = await fetchImpl(`${base}${path2}`, {
      method,
      headers: {
        authorization: `Bearer ${target.token}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        ...body2 === void 0 ? {} : { "content-type": "application/json" }
      },
      ...body2 === void 0 ? {} : { body: JSON.stringify(body2) },
      signal: AbortSignal.timeout(3e4)
    });
    let json = null;
    try {
      json = await response.json();
    } catch {
    }
    return { status: response.status, headers: response.headers, json };
  };
}
function isRateLimited2(answer) {
  const message = answer.json?.message;
  return answer.headers.has("retry-after") || answer.headers.get("x-ratelimit-remaining") === "0" || typeof message === "string" && /rate limit/i.test(message);
}
function ensureAnswered(status, what) {
  if (status < 200 || status >= 300) throw new Error(`GitHub answered HTTP ${status} while ${what}`);
}

// src/setup/hooks.ts
var PRE_COMMIT_CONFIG = ".pre-commit-config.yaml";
var SECURITY_ALIAS = "security";
var LINEAR_FORMAT_HOOK = "linear-format";
var LOCAL_REPOS = /* @__PURE__ */ new Set(["local", "meta"]);
function readHookConfig(text4) {
  if (text4 === null) return { hooks: [] };
  let data;
  try {
    data = parseQuietly(text4);
  } catch {
    return { hooks: [], invalid: `${PRE_COMMIT_CONFIG} is not valid YAML` };
  }
  const repos = isRecord(data) ? data.repos : void 0;
  if (!Array.isArray(repos)) return { hooks: [], invalid: `${PRE_COMMIT_CONFIG} has no "repos" list` };
  const hooks = [];
  for (const repo of repos) {
    if (!isRecord(repo) || !Array.isArray(repo.hooks)) continue;
    const source = typeof repo.repo === "string" ? repo.repo : "";
    for (const hook of repo.hooks) {
      if (!isRecord(hook) || typeof hook.id !== "string") continue;
      hooks.push(typeof hook.alias === "string" ? { id: hook.id, repo: source, alias: hook.alias } : { id: hook.id, repo: source });
    }
  }
  return { hooks };
}
function securityHooks(config) {
  return config.hooks.filter((hook) => hook.alias === SECURITY_ALIAS).map((hook) => hook.id);
}
function checkSecurityHooks(config) {
  const ids = securityHooks(config);
  if (ids.length > 0) return passed("security-hooks", `security hooks present: ${ids.join(", ")}`);
  return { name: "security-hooks", state: "warning", detail: `no pre-commit hook marked "alias: ${SECURITY_ALIAS}": content is pushed unchecked` };
}
function checkLinearFormatHook(config) {
  if (config.invalid !== void 0) return failed("linear-format-hook", "linear-format-hook-required", config.invalid);
  const configured = config.hooks.some((hook) => hook.id === LINEAR_FORMAT_HOOK && !LOCAL_REPOS.has(hook.repo));
  return configured ? passed("linear-format-hook", `${PRE_COMMIT_CONFIG} has the ${LINEAR_FORMAT_HOOK} hook`) : failed("linear-format-hook", "linear-format-hook-required", `${PRE_COMMIT_CONFIG} has no ${LINEAR_FORMAT_HOOK} hook`);
}
function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// src/setup/check.ts
async function runSetupCheck(input) {
  const annotations = checkAnnotations(input.mapping);
  let credentials;
  let targets = { result: notChecked("annotation-targets", "needs working Linear credentials") };
  if ("error" in input.linear) {
    credentials = linearCredentialFailure(input.linear.error);
  } else {
    credentials = checkLinearScopes(input.linear.scope);
    if (credentials.state === "passed" && annotations.state === "passed") {
      const resolved = await resolveTargets(input.linear.client, input.mapping.zones.values());
      if (resolved.credentials !== void 0) credentials = resolved.credentials;
      targets = resolved;
    } else if (annotations.state !== "passed") {
      targets = { result: notChecked("annotation-targets", "needs usable annotations") };
    }
  }
  const checks = [
    credentials,
    input.github.access,
    input.github.mergeCommits,
    checkLinearFormatHook(input.hooks),
    annotations,
    targets.result,
    checkLeftOut(input.mapping),
    checkSecurityHooks(input.hooks)
  ];
  const report = buildReport(checks, securityHooks(input.hooks));
  return report.ok && targets.targets !== void 0 ? { report, targets: targets.targets } : { report };
}
var LEFT_OUT_NAMED = 20;
function checkLeftOut(mapping) {
  const files = [...mapping.leftOut].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  if (files.length === 0) return passed("left-out-files", "no files left out");
  const named = files.slice(0, LEFT_OUT_NAMED).map((file) => `${file.path} (${file.rule})`);
  const more = files.length > LEFT_OUT_NAMED ? `, and ${files.length - LEFT_OUT_NAMED} more` : "";
  return { name: "left-out-files", state: "warning", detail: `${files.length} files left out, not synced: ${named.join(", ")}${more}` };
}
function checkAnnotations(mapping) {
  if (mapping.problems.length > 0) {
    return failed("annotations", "invalid-annotation", mapping.problems.map((problem) => problem.message).join("; "));
  }
  if (mapping.annotations.length === 0) {
    return failed("annotations", "no-annotations", "no folder has linear-team or linear-project in its README.md front matter");
  }
  return passed("annotations", `${mapping.annotations.length} annotated folders, ${mapping.documents.length} files to sync`);
}

// src/state/config.ts
var STORES = ["linear", "ids", "uploads"];
var DEFAULT_STATE_CONFIG = Object.freeze({
  remote: "origin",
  trackedBranch: "main",
  syncBranch: "mdbisync/linear",
  refPrefix: "refs/mdbisync"
});
var StateConfigError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "StateConfigError";
  }
};
function resolveStateConfig(input = {}) {
  const pick = (key) => {
    const value = input[key];
    return value === void 0 || value.trim() === "" ? DEFAULT_STATE_CONFIG[key] : value.trim();
  };
  const config = {
    remote: pick("remote"),
    trackedBranch: pick("trackedBranch"),
    syncBranch: pick("syncBranch"),
    refPrefix: pick("refPrefix").replace(/\/+$/, "")
  };
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(config.remote)) {
    throw new StateConfigError(`remote "${config.remote}" is not a valid remote name`);
  }
  for (const key of ["trackedBranch", "syncBranch"]) {
    const problem = refNameProblem(`refs/heads/${config[key]}`) ?? (config[key].startsWith("-") ? 'starts with "-"' : null);
    if (problem !== null) throw new StateConfigError(`${key} "${config[key]}" is not a valid branch name: ${problem}`);
  }
  if (config.trackedBranch === config.syncBranch) {
    throw new StateConfigError("the tracked branch and the sync branch must differ");
  }
  if (config.syncBranch.startsWith(`${config.trackedBranch}/`) || config.trackedBranch.startsWith(`${config.syncBranch}/`)) {
    throw new StateConfigError("one of the tracked branch and the sync branch is a folder of the other");
  }
  const prefixProblem = refNameProblem(`${config.refPrefix}/linear`);
  if (prefixProblem !== null) {
    throw new StateConfigError(`refPrefix "${config.refPrefix}" is not a valid ref prefix: ${prefixProblem}`);
  }
  if (!/^refs\/[^/]/.test(config.refPrefix)) {
    throw new StateConfigError(`refPrefix "${config.refPrefix}" must start with "refs/" and name a folder under it`);
  }
  if (/^refs\/(heads|tags|remotes)(\/|$)/.test(config.refPrefix)) {
    throw new StateConfigError(`refPrefix "${config.refPrefix}" must not be under refs/heads, refs/tags or refs/remotes`);
  }
  return config;
}
function stateRef(config, store) {
  return `${config.refPrefix}/${store}`;
}
function branchRef(branch) {
  return `refs/heads/${branch}`;
}
function localRef(config, remoteRef) {
  return remoteRef.startsWith("refs/heads/") ? `refs/remotes/${config.remote}/${remoteRef.slice("refs/heads/".length)}` : remoteRef;
}
function refNameProblem(name) {
  if (!name.startsWith("refs/")) return 'does not start with "refs/"';
  if (name.endsWith("/")) return 'ends with "/"';
  if (name.endsWith(".")) return 'ends with "."';
  if (name.includes("//")) return 'contains "//"';
  if (name.includes("..")) return 'contains ".."';
  if (name.includes("@{")) return 'contains "@{"';
  if (/[\x00-\x20\x7f~^:?*[\\]/.test(name)) return "contains a character git does not allow";
  for (const part of name.split("/")) {
    if (part.startsWith(".")) return 'has a part starting with "."';
    if (part.endsWith(".lock")) return 'has a part ending with ".lock"';
  }
  return null;
}

// src/state/state.ts
async function fetchState(git, config) {
  const tracked = branchRef(config.trackedBranch);
  const sync = branchRef(config.syncBranch);
  const advertised = await lsRemote(git, config.remote, [tracked, sync, ...STORES.map((store) => stateRef(config, store))]);
  if (!advertised.has(tracked)) {
    throw new Error(`the tracked branch "${config.trackedBranch}" does not exist on remote "${config.remote}"`);
  }
  const present = [...advertised.keys()];
  const refspecs = present.map((ref) => `+${ref}:${localRef(config, ref)}`);
  await git.run(["fetch", "--no-tags", "--no-write-fetch-head", "--quiet", config.remote, ...refspecs]);
  const read = async (ref) => {
    const local = localRef(config, ref);
    if (advertised.has(ref)) return git.text(["rev-parse", "--verify", `${local}^{commit}`]);
    await git.run(["update-ref", "-d", local]);
    return null;
  };
  const state = {};
  for (const store of STORES) state[store] = await read(stateRef(config, store));
  return { tracked: await read(tracked), sync: await read(sync), state };
}
async function lsRemote(git, remote, refs) {
  const output = await git.text(["ls-remote", "--refs", remote, ...refs]);
  const wanted = new Set(refs);
  const result = /* @__PURE__ */ new Map();
  for (const line2 of output.split("\n")) {
    const [oid, ref] = line2.split("	");
    if (oid !== void 0 && ref !== void 0 && wanted.has(ref)) result.set(ref, oid);
  }
  return result;
}
var refusals = /* @__PURE__ */ new WeakMap();
function refusedPushes(git) {
  return refusals.get(git) ?? [];
}
var moves = /* @__PURE__ */ new WeakMap();
function movedRefs(git) {
  return new Map(moves.get(git) ?? []);
}
function refRole(config, ref) {
  const store = STORES.find((name) => stateRef(config, name) === ref);
  if (store !== void 0) return store;
  if (ref === branchRef(config.syncBranch)) return "syncBranch";
  return ref === branchRef(config.trackedBranch) ? "trackedBranch" : "other";
}
function logMoves(git, config, refs) {
  const log = moves.get(git) ?? /* @__PURE__ */ new Map();
  for (const ref of refs) {
    const role = refRole(config, ref);
    log.set(role, (log.get(role) ?? 0) + 1);
  }
  moves.set(git, log);
}
var NotFastForwardError = class extends Error {
  constructor(ref) {
    super(`refusing to move ${ref} to a commit that does not descend from its current value`);
    this.name = "NotFastForwardError";
  }
};
async function pushAtomic(git, config, updates) {
  if (new Set(updates.map((update) => update.ref)).size !== updates.length) {
    throw new Error("a push names the same ref twice");
  }
  const changing = updates.filter((update) => update.next !== update.expected);
  if (changing.length === 0) return { ok: true, updated: [] };
  for (const update of changing) {
    if (update.expected !== null && update.replace !== true) {
      const ancestor = await git.run(["merge-base", "--is-ancestor", update.expected, update.next], { okCodes: [0, 1] });
      if (ancestor.code !== 0) throw new NotFastForwardError(update.ref);
    }
  }
  const before = await lsRemote(git, config.remote, updates.map((update) => update.ref));
  const skipped = updates.filter((update) => update.next !== update.expected && before.get(update.ref) === update.next);
  if (skipped.length > 0) {
    logRefusal(git, changing, []);
    return { ok: false, reason: "stale", refs: skipped.map((update) => ({ ref: update.ref, message: "already at the new value, not at the expected one" })) };
  }
  const args = ["push", "--atomic", "--porcelain", "--no-verify", config.remote];
  for (const update of updates) args.push(`--force-with-lease=${update.ref}:${update.expected ?? ""}`);
  for (const update of updates) args.push(`${update.next}:${update.ref}`);
  const result = await git.run(args, { okCodes: [0, 1] });
  const lines2 = parsePorcelain(result.stdout.toString("utf8"));
  if (result.code === 0) {
    const input = changing.map((update) => `update ${localRef(config, update.ref)} ${update.next}
`).join("");
    await git.run(["update-ref", "--stdin"], { input, okCodes: [0, 1, 128] });
    const unchanged = new Set(lines2.filter((line2) => line2.flag === "=").map((line2) => line2.ref));
    logMoves(git, config, changing.map((update) => update.ref).filter((ref) => !unchanged.has(ref)));
    return { ok: true, updated: changing.map((update) => update.ref) };
  }
  const rejected = lines2.filter((line2) => line2.flag === "!");
  if (rejected.length === 0) throw new GitError(args, result.code, result.stderr);
  const stale = rejected.some((line2) => line2.summary.includes("stale info")) || await movedAway(git, config.remote, updates);
  if (stale) logRefusal(git, changing, lines2.filter((line2) => line2.flag !== "!" && line2.flag !== "=").map((line2) => line2.ref));
  return {
    ok: false,
    reason: stale ? "stale" : "rejected",
    refs: rejected.map((line2) => ({ ref: line2.ref, message: line2.summary }))
  };
}
async function movedAway(git, remote, updates) {
  const current = await lsRemote(git, remote, updates.map((update) => update.ref));
  return updates.some((update) => (current.get(update.ref) ?? null) !== update.expected);
}
function logRefusal(git, changing, moved) {
  const log = refusals.get(git) ?? [];
  log.push({ refs: changing.map((update) => update.ref), moved });
  refusals.set(git, log);
}
function parsePorcelain(output) {
  const lines2 = [];
  for (const line2 of output.split("\n")) {
    const parts = line2.split("	");
    if (parts.length < 3 || parts[0].length !== 1) continue;
    const refs = parts[1];
    lines2.push({ flag: parts[0], ref: refs.slice(refs.lastIndexOf(":") + 1), summary: parts.slice(2).join("	") });
  }
  return lines2;
}
var IDS_FILE = "ids.json";
var UPLOADS_FILE = "uploads.json";
async function readIds(git, commit) {
  const data = await readJsonFile(git, commit, IDS_FILE);
  const map = /* @__PURE__ */ new Map();
  for (const [path2, value] of Object.entries(data)) {
    if (!isIdEntry(value)) throw new Error(`${IDS_FILE} has an invalid entry for a path`);
    map.set(path2, value.saved === void 0 ? { id: value.id } : { id: value.id, saved: value.saved });
  }
  return map;
}
async function readUploads(git, commit) {
  const data = await readJsonFile(git, commit, UPLOADS_FILE);
  const map = /* @__PURE__ */ new Map();
  for (const [hash, url] of Object.entries(data)) {
    if (!/^[0-9a-f]{64}$/.test(hash) || typeof url !== "string") throw new Error(`${UPLOADS_FILE} has an invalid entry`);
    map.set(hash, url);
  }
  return map;
}
var INITIAL_SYNC_PROGRESS = "Initial sync in progress: document ids";
function initialSyncProgressMessage(tracked) {
  return `${INITIAL_SYNC_PROGRESS}

Tracked: ${tracked}
`;
}
async function readInitialSyncProgress(git, commit) {
  if (commit === null) return null;
  const message = (await git.run(["show", "-s", "--format=%B", commit])).stdout.toString("utf8");
  const [subject] = message.split("\n");
  if (subject !== INITIAL_SYNC_PROGRESS) return null;
  return { tracked: /^Tracked: ([0-9a-f]{40,64})$/m.exec(message)?.[1] ?? null };
}
var INITIAL_SYNC_FROM_LINEAR_RECORD = "Initial sync from Linear: Linear's state";
async function isAncestor(git, commit, of) {
  return (await git.run(["merge-base", "--is-ancestor", commit, of], { okCodes: [0, 1] })).code === 0;
}
async function initialPullRequestPending(git, state) {
  const { linear, tracked } = state;
  if (linear === null) return false;
  const [subject] = (await git.text(["show", "-s", "--format=%s", linear])).split("\n");
  if (subject !== INITIAL_SYNC_FROM_LINEAR_RECORD) return false;
  if (await isAncestor(git, linear, tracked)) return false;
  return initialRecordChangesParent(git, linear);
}
async function initialRecordChangesParent(git, record) {
  const parent = await git.run(["rev-parse", "--verify", "--quiet", `${record}^1`], { okCodes: [0, 1] });
  if (parent.code !== 0) return true;
  return (await git.run(["diff", "--quiet", parent.stdout.toString("utf8").trim(), record], { okCodes: [0, 1] })).code === 1;
}
var RESERVED_IDS_FILE = "reserved-ids.json";
async function readReservedIds(git, commit) {
  if (commit === null) return /* @__PURE__ */ new Map();
  const read = await git.run(["cat-file", "blob", `${commit}:${RESERVED_IDS_FILE}`], { okCodes: [0, 128] });
  if (read.code !== 0) return /* @__PURE__ */ new Map();
  const data = await readJsonFile(git, commit, RESERVED_IDS_FILE);
  const map = /* @__PURE__ */ new Map();
  for (const [path2, id] of Object.entries(data)) {
    if (typeof id !== "string" || id === "") throw new Error(`${RESERVED_IDS_FILE} has an invalid entry`);
    map.set(path2, id);
  }
  return map;
}
var WRITTEN_FILE = "written.json";
async function readWrittenHashes(git, commit) {
  if (commit === null) return /* @__PURE__ */ new Map();
  const read = await git.run(["cat-file", "blob", `${commit}:${WRITTEN_FILE}`], { okCodes: [0, 128] });
  if (read.code !== 0) return /* @__PURE__ */ new Map();
  const data = await readJsonFile(git, commit, WRITTEN_FILE);
  const map = /* @__PURE__ */ new Map();
  for (const [path2, hash] of Object.entries(data)) {
    if (typeof hash !== "string" || !/^[0-9a-f]{64}$/.test(hash)) throw new Error(`${WRITTEN_FILE} has an invalid entry`);
    map.set(path2, hash);
  }
  return map;
}
function commitIds(git, parent, ids, identity, options = {}) {
  const entries = [...ids.entries()].sort(([a], [b]) => compareStrings(a, b));
  const data = Object.fromEntries(entries.map(([path2, entry]) => [path2, entry.saved === void 0 ? { id: entry.id } : { id: entry.id, saved: entry.saved }]));
  const files = /* @__PURE__ */ new Map([[IDS_FILE, data]]);
  const sorted = (map) => Object.fromEntries([...map.entries()].sort(([a], [b]) => compareStrings(a, b)));
  if (options.reserved !== void 0 && options.reserved.size > 0) files.set(RESERVED_IDS_FILE, sorted(options.reserved));
  if (options.written !== void 0 && options.written.size > 0) files.set(WRITTEN_FILE, sorted(options.written));
  return commitJsonFiles(git, parent, files, options.message ?? "Update document ids", identity, options.always === true);
}
var UPLOADS_REBUILDING = "Upload cache lost: uploading again";
var UPLOADS_REBUILT = "Upload cache uploaded again";
async function uploadsRebuilding(git, commit) {
  if (commit === null) return true;
  const subject = await git.text(["log", "-1", "--format=%s", "--fixed-strings", `--grep=${UPLOADS_REBUILDING}`, `--grep=${UPLOADS_REBUILT}`, commit]);
  return subject.trim() === UPLOADS_REBUILDING;
}
function commitUploads(git, parent, uploads, identity, options = {}) {
  const data = Object.fromEntries([...uploads.entries()].sort(([a], [b]) => compareStrings(a, b)));
  return commitJsonFiles(git, parent, /* @__PURE__ */ new Map([[UPLOADS_FILE, data]]), options.message ?? "Update upload cache", identity, options.always === true);
}
function compareStrings(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}
function isIdEntry(value) {
  if (typeof value !== "object" || value === null) return false;
  const entry = value;
  if (typeof entry.id !== "string" || entry.id === "") return false;
  if (entry.saved === void 0) return true;
  const saved = entry.saved;
  return typeof saved === "object" && saved !== null && (saved.icon === null || typeof saved.icon === "string") && (saved.color === null || typeof saved.color === "string") && (saved.notice === void 0 || isMarkNotice(saved.notice));
}
function isMarkNotice(value) {
  if (typeof value !== "object" || value === null) return false;
  const notice = value;
  return typeof notice.id === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(notice.id) && (notice.kind === "conflict" || notice.kind === "blocked") && typeof notice.bodyHash === "string" && /^[0-9a-f]{64}$/.test(notice.bodyHash) && typeof notice.posted === "boolean";
}
async function readJsonFile(git, commit, file) {
  if (commit === null) return {};
  const read = await git.run(["cat-file", "blob", `${commit}:${file}`], { okCodes: [0, 128] });
  if (read.code !== 0) throw new Error(`${file} is missing in state commit ${commit}`);
  const blob = read.stdout;
  let data;
  try {
    data = JSON.parse(blob.toString("utf8"));
  } catch {
    throw new Error(`${file} in ${commit} is not valid JSON`);
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) throw new Error(`${file} in ${commit} is not a JSON object`);
  return data;
}
function commitJsonFiles(git, parent, files, message, identity, always = false) {
  return commitTree(git, {
    parents: parent === null ? [] : [parent],
    base: null,
    changes: new Map([...files].map(([file, data]) => [file, `${JSON.stringify(data, null, 2)}
`])),
    message,
    identity,
    skipIfUnchanged: !always
  });
}
async function readFiles(git, config, commit, paths) {
  const wanted = new Set(paths);
  const entries = /* @__PURE__ */ new Map();
  for (const entry of await listTree(git, commit)) if (wanted.has(entry.path)) entries.set(entry.path, entry);
  const result = /* @__PURE__ */ new Map();
  const blobs = await readBlobs(
    git,
    [...entries.values()].filter((entry) => entry.type === "blob").map((entry) => entry.oid)
  );
  const pointers = /* @__PURE__ */ new Map();
  for (const path2 of wanted) {
    const entry = entries.get(path2);
    if (entry === void 0) {
      result.set(path2, { ok: false, reason: "not in the tree" });
      continue;
    }
    if (entry.type !== "blob" || entry.mode === "120000") {
      result.set(path2, { ok: false, reason: "not a regular file" });
      continue;
    }
    const blob = blobs.get(entry.oid);
    const pointer = parseLfsPointer(blob);
    if (pointer === null) result.set(path2, { ok: true, content: blob, lfs: false });
    else if (!pointers.has(entry.oid)) pointers.set(entry.oid, { pointer, path: path2 });
  }
  const lfs = /* @__PURE__ */ new Map();
  if (pointers.size > 0) {
    const read = await lfsReader(git, config.remote);
    const items = [...pointers.entries()];
    const results = await mapLimit(items, 4, ([, item]) => read(item.pointer, item.path));
    items.forEach(([pointerBlob], index2) => lfs.set(pointerBlob, results[index2]));
  }
  for (const path2 of wanted) {
    if (result.has(path2)) continue;
    const read = lfs.get(entries.get(path2).oid);
    result.set(path2, read.ok ? { ok: true, content: read.content, lfs: true } : read);
  }
  return new Map([...wanted].map((path2) => [path2, result.get(path2)]));
}

// src/setup/state.ts
function checkSyncState(state, config, initialSyncUnfinished = false, initialPullRequestPending2 = false) {
  if (initialSyncUnfinished) {
    return {
      code: "initial-sync-required",
      message: "An initial sync stopped before it finished: run it again with the same inputs first. The sync wrote nothing."
    };
  }
  if (state.linear === null) {
    return {
      code: "initial-sync-required",
      message: `${stateRef(config, "linear")} does not exist: run initial sync first. The sync wrote nothing.`
    };
  }
  if (initialPullRequestPending2) {
    return {
      code: "initial-pull-request-pending",
      message: `The pull request of the initial sync from Linear is not merged into ${config.trackedBranch} yet: a person reviews and merges it with a merge commit (it can remove files), then the sync runs. Closing the pull request or deleting its branch does not cancel this unmerged snapshot. To start over instead, close that pull request, delete the branch ${config.syncBranch} and run initial sync again to replace the snapshot. The sync wrote nothing.`
    };
  }
  return null;
}

// src/setup/summary.ts
var MARK = { passed: "passed", failed: "FAILED", warning: "warning", "not-checked": "not checked" };
function renderSetupSummary(report) {
  const fix = fixUrl(report.code);
  const lines2 = [
    "## Setup check",
    "",
    report.ok ? "Every required item passed." : `Stopped before any write: \`${report.code}\`.${fix === void 0 ? "" : ` How to fix it: ${fix}`}`,
    "",
    "| Item | State | Detail |",
    "| --- | --- | --- |",
    ...report.checks.map((check) => {
      const link = check.state === "failed" ? fixUrl(check.code) : void 0;
      return `| ${check.name} | ${MARK[check.state]} | ${cell(check.detail)}${link === void 0 ? "" : ` ([how to fix](${link}))`} |`;
    }),
    ""
  ];
  return lines2.join("\n");
}
function renderStateRefusal(refusal) {
  return ["## Sync", "", `Stopped before any write: \`${refusal.code}\`.`, "", refusal.message, "", `How to fix it: ${QUICKSTART_URL}#${FIX_ANCHORS[refusal.code]}`, ""].join("\n");
}

// src/initial-sync/confirm.ts
import { createHash as createHash4, randomUUID } from "node:crypto";

// src/test-hooks.ts
import { existsSync as existsSync2, mkdirSync, writeFileSync as writeFileSync2 } from "node:fs";
import { isAbsolute, join as join4 } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
var HOOKS_ENV = "MDBISYNC_TEST_HOOKS";
var HOOKS_DIR_ENV = "MDBISYNC_TEST_HOOKS_DIR";
var STOP_AFTER_ENV = "MDBISYNC_TEST_STOP_AFTER_DOCUMENTS";
var POLL_MS = 50;
var TestHookError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "TestHookError";
  }
};
function hooksEnabled(env = process.env) {
  return env[HOOKS_ENV] === "1";
}
function hooksDir(env = process.env) {
  if (!hooksEnabled(env)) return null;
  const dir = env[HOOKS_DIR_ENV] ?? "";
  if (!isAbsolute(dir)) throw new TestHookError(`${HOOKS_ENV}=1 needs an absolute ${HOOKS_DIR_ENV}`);
  return dir;
}
function testStopAfterDocuments(env = process.env) {
  if (!hooksEnabled(env)) return void 0;
  const value = env[STOP_AFTER_ENV];
  if (value === void 0 || value === "") return void 0;
  const count4 = Number(value);
  if (!Number.isInteger(count4) || count4 < 0) throw new TestHookError(`${STOP_AFTER_ENV} must be a whole number`);
  return count4;
}
var counts = /* @__PURE__ */ new Map();
async function checkpoint(name, env = process.env) {
  const dir = hooksDir(env);
  if (dir === null) return;
  const count4 = (counts.get(name) ?? 0) + 1;
  counts.set(name, count4);
  mark(dir, "reached", name, count4);
  while (existsSync2(join4(dir, "pause", name))) await sleep(POLL_MS);
  mark(dir, "passed", name, count4);
}
function mark(dir, kind, name, count4) {
  mkdirSync(join4(dir, kind), { recursive: true });
  writeFileSync2(join4(dir, kind, name), `${JSON.stringify({ pid: process.pid, count: count4, at: (/* @__PURE__ */ new Date()).toISOString() })}
`);
}

// src/initial-sync/uploads.ts
import { createHash as createHash3 } from "node:crypto";
import { posix as posix2 } from "node:path";

// src/initial-sync/transform.ts
var LeaveOutError = class extends Error {
  rule;
  /** The files that caused it, by repository path (a file over the upload limit). */
  files;
  constructor(rule, message, files = []) {
    super(message);
    this.name = "LeaveOutError";
    this.rule = rule;
    this.files = files;
  }
};
async function transformBody(transforms, path2, body2) {
  let current = body2;
  for (const transform of transforms) current = await transform.apply({ path: path2, body: current });
  return current;
}
function restoreBody(transforms, path2, content4, sent) {
  const kept = sameMarkdown(content4, sent);
  let current = kept ? sent : content4;
  for (const transform of [...transforms].reverse()) current = transform.restore({ path: path2, body: current, kept });
  if (kept) return current;
  const notUploaded = relativeLinkUrls(content4);
  return fixText(current, { linkedFileExists: (url) => !notUploaded.has(url) });
}

// src/initial-sync/uploads.ts
var DEFAULT_UPLOAD_LIMIT = 10 * 1024 * 1024;
var UPLOAD_TOO_LARGE = "upload-too-large";
var UPLOAD_UNREADABLE = "upload-unreadable";
var HASH_BATCH_BYTES = 64 * 1024 * 1024;
var MAX_POINTER_SIZE2 = 1024;
var UPLOAD_BATCH_FILES = 20;
var UPLOAD_BATCH_BYTES = 64 * 1024 * 1024;
async function predictUploadLeaveOuts(git, tracked, plan, texts, uploads, options = {}) {
  const limit = options.limit ?? DEFAULT_UPLOAD_LIMIT;
  const { files } = await treeFiles(git, tracked);
  const planned = plannedLinks(plan, files, texts);
  const targets = [...new Set([...planned.values()].flat())];
  const linked = /* @__PURE__ */ new Map();
  await hashLinkedFiles(git, files, linked, targets, MAX_POINTER_SIZE2);
  const uploaded = new Set(uploads.keys());
  const file = (target) => linked.get(target);
  if (targets.some((target) => file(target).extensions && !uploaded.has(file(target).hash))) {
    for (const target of targets) if (file(target).hash === "" && file(target).size <= limit) linked.delete(target);
    await hashLinkedFiles(git, files, linked, targets, Math.max(limit, MAX_POINTER_SIZE2));
  }
  const result = [];
  for (const path2 of [...planned.keys()].sort(compare2)) {
    const own3 = planned.get(path2);
    const leaveOut = judgeLinkedFiles(own3, linked, limit, uploaded);
    if (leaveOut !== null) result.push({ path: path2, rule: leaveOut.rule, files: leaveOut.files });
    else for (const target of own3) uploaded.add(file(target).hash);
  }
  return result;
}
function judgeLinkedFiles(targets, linked, limit, uploaded) {
  const file = (target) => linked.get(target);
  const oversize = targets.filter((target) => file(target).size > limit);
  if (oversize.length > 0) return { rule: UPLOAD_TOO_LARGE, files: oversize, message: `${oversize.join(", ")}: over the upload limit of ${limit} bytes` };
  const readable = new Set(targets.filter((target) => !file(target).extensions).map((target) => file(target).hash));
  const unreadable = targets.filter((target) => file(target).extensions && !uploaded.has(file(target).hash) && !readable.has(file(target).hash));
  if (unreadable.length > 0) {
    return { rule: UPLOAD_UNREADABLE, files: unreadable, message: `${unreadable.join(", ")}: stored with LFS extensions, which are not supported` };
  }
  return null;
}
async function treeFiles(git, tracked) {
  const files = /* @__PURE__ */ new Map();
  const markdown = /* @__PURE__ */ new Map();
  for (const entry of await listTree(git, tracked)) {
    if (entry.type !== "blob" || entry.mode === "120000") continue;
    if (entry.path.endsWith(MARKDOWN_EXTENSION)) markdown.set(entry.path, entry);
    else files.set(entry.path, entry);
  }
  return { files, markdown };
}
function plannedLinks(plan, files, texts) {
  const isFile = (path2) => files.has(path2);
  const planned = /* @__PURE__ */ new Map();
  for (const { path: path2 } of [...plan.create, ...plan.overwrite]) {
    const text4 = texts.get(path2);
    if (text4 === void 0) continue;
    const targets = [...new Set(findFileLinks(path2, splitFile(text4).body, isFile).map((link) => link.target))];
    if (targets.length > 0) planned.set(path2, targets);
  }
  return planned;
}
async function hashLinkedFiles(git, files, linked, paths, readUpTo) {
  const toRead = [];
  for (const path2 of new Set(paths)) {
    if (linked.has(path2)) continue;
    const entry = files.get(path2);
    if (entry.size !== null && entry.size > readUpTo) linked.set(path2, { hash: "", size: entry.size, extensions: false });
    else toRead.push(entry);
  }
  let index2 = 0;
  while (index2 < toRead.length) {
    const batch = [];
    let bytes = 0;
    while (index2 < toRead.length && (batch.length === 0 || bytes + (toRead[index2].size ?? 0) <= HASH_BATCH_BYTES)) {
      const entry = toRead[index2];
      batch.push(entry);
      bytes += entry.size ?? 0;
      index2 += 1;
    }
    const blobs = await readBlobs(git, batch.map((entry) => entry.oid));
    for (const entry of batch) {
      const blob = blobs.get(entry.oid);
      const pointer = parseLfsPointer(blob);
      linked.set(
        entry.path,
        pointer !== null ? { hash: pointer.oid, size: pointer.size, extensions: pointer.extensions } : { hash: sha2562(blob), size: blob.length, extensions: false }
      );
    }
  }
}
function uploadsTransform(options) {
  const limit = options.limit ?? DEFAULT_UPLOAD_LIMIT;
  let context;
  const files = /* @__PURE__ */ new Map();
  const linked = /* @__PURE__ */ new Map();
  const links = /* @__PURE__ */ new Map();
  const planned = /* @__PURE__ */ new Map();
  const order = [];
  let lfs;
  const isFile = (path2) => files.has(path2);
  const hashFiles = (git, paths) => hashLinkedFiles(git, files, linked, paths, Math.max(limit, MAX_POINTER_SIZE2));
  const missing = (targets) => {
    const { uploads } = context;
    const byHash = /* @__PURE__ */ new Map();
    for (const target of targets) {
      const { hash } = linked.get(target);
      if (uploads.has(hash)) continue;
      const chosen = byHash.get(hash);
      if (chosen === void 0 || linked.get(chosen).extensions && !linked.get(target).extensions) byHash.set(hash, target);
    }
    return byHash;
  };
  const readContents = async (byHash) => {
    const { git } = context;
    const blobs = await readBlobs(git, [...byHash.values()].map((target) => files.get(target).oid));
    const contents = /* @__PURE__ */ new Map();
    for (const [hash, target] of byHash) {
      const blob = blobs.get(files.get(target).oid);
      const pointer = parseLfsPointer(blob);
      if (pointer === null) {
        contents.set(hash, blob);
        continue;
      }
      lfs ??= await lfsReader(git, options.config.remote);
      const read = await lfs(pointer, target);
      contents.set(hash, read.ok ? read.content : { unreadable: read.reason });
    }
    return contents;
  };
  const uploadAll = async (items) => {
    const { linear, uploads } = context;
    const inputs = items.map(({ target, content: content4 }) => ({
      filename: posix2.basename(target),
      contentType: contentTypeOf(target),
      // A copy, so the bytes sent are a whole ArrayBuffer of their own, as the client's type requires.
      bytes: new Uint8Array(content4)
    }));
    const results = await linear.uploadFiles(inputs);
    items.forEach(({ hash }, index2) => uploads.set(hash, results[index2].assetUrl));
  };
  const readDocumentFiles = async (targets, batch) => {
    const taken = new Set(batch.map((item) => item.hash));
    const byHash = new Map([...missing(targets)].filter(([hash]) => !taken.has(hash)));
    if (byHash.size === 0) return [];
    const contents = await readContents(byHash);
    const result = [];
    for (const [hash, target] of byHash) {
      const content4 = contents.get(hash);
      if (!Buffer.isBuffer(content4)) return { unreadable: content4.unreadable, target };
      result.push({ hash, target, content: content4 });
    }
    return result;
  };
  const uploadMissing = async (path2, targets) => {
    const own3 = await readDocumentFiles(targets, []);
    if (!Array.isArray(own3)) throw new LeaveOutError(UPLOAD_UNREADABLE, `${own3.target} cannot be read: ${own3.unreadable}`, [own3.target]);
    if (own3.length === 0) return;
    const batch = [...own3];
    let bytes = batch.reduce((sum, item) => sum + item.content.length, 0);
    const position2 = order.indexOf(path2);
    for (const next of position2 === -1 ? [] : order.slice(position2 + 1)) {
      if (batch.length >= UPLOAD_BATCH_FILES) break;
      const nextTargets = planned.get(next);
      await hashFiles(context.git, nextTargets);
      if (nextTargets.some((target) => linked.get(target).size > limit)) continue;
      const pending = [...missing(nextTargets)].filter(([hash]) => !batch.some((item) => item.hash === hash));
      const pendingBytes = pending.reduce((sum, [, target]) => sum + linked.get(target).size, 0);
      if (pending.length === 0) continue;
      if (batch.length + pending.length > UPLOAD_BATCH_FILES || bytes + pendingBytes > UPLOAD_BATCH_BYTES) break;
      const files2 = await readDocumentFiles(nextTargets, batch);
      if (!Array.isArray(files2)) continue;
      batch.push(...files2);
      bytes += pendingBytes;
    }
    try {
      await uploadAll(batch);
    } catch (error) {
      if (batch.length === own3.length || !(error instanceof LinearError) || error instanceof LinearStoppedError) throw error;
      await uploadAll(own3);
    }
  };
  return {
    name: "uploads",
    async prepare(ctx) {
      context = ctx;
      const tree = await treeFiles(ctx.git, ctx.tracked);
      for (const [path2, entry] of tree.files) files.set(path2, entry);
      const paths = [...ctx.plan.create, ...ctx.plan.overwrite].map((entry) => entry.path).filter((path2) => tree.markdown.has(path2));
      const blobs = await readBlobs(ctx.git, paths.map((path2) => tree.markdown.get(path2).oid));
      const texts = /* @__PURE__ */ new Map();
      for (const path2 of paths) {
        const blob = blobs.get(tree.markdown.get(path2).oid);
        if (parseLfsPointer(blob) === null) texts.set(path2, blob.toString("utf8"));
      }
      for (const [path2, targets] of plannedLinks(ctx.plan, files, texts)) planned.set(path2, targets);
      order.push(...[...planned.keys()].sort(compare2));
    },
    async apply({ path: path2, body: body2 }) {
      if (context === void 0) throw new Error("the uploads transform was not prepared");
      const fileLinks = findFileLinks(path2, body2, isFile);
      if (fileLinks.length === 0) return body2;
      const targets = [...new Set(fileLinks.map((link) => link.target))];
      await hashFiles(context.git, targets);
      const leaveOut = judgeLinkedFiles(targets, linked, limit, context.uploads);
      if (leaveOut !== null) throw new LeaveOutError(leaveOut.rule, leaveOut.message, leaveOut.files);
      await uploadMissing(path2, targets);
      const { uploads } = context;
      const urls = fileLinks.map((link) => uploads.get(linked.get(link.target).hash));
      links.set(path2, fileLinks.map((link) => ({ written: link.written, hash: linked.get(link.target).hash, suffix: link.suffix })));
      return replaceRanges(body2, fileLinks.map((link, index2) => ({ from: link.from, to: link.to, text: urls[index2] + link.suffix })));
    },
    restore({ path: path2, body: body2 }) {
      const fileLinks = links.get(path2);
      if (fileLinks === void 0 || context === void 0) return body2;
      return restoreFileLinks(body2, fileLinks, context.uploads);
    }
  };
}
function restoreFileLinks(body2, written, uploads) {
  const raws = /* @__PURE__ */ new Map();
  for (const link of written) {
    const url = uploads.get(link.hash);
    if (url === void 0) continue;
    const key = url + link.suffix;
    raws.set(key, [...raws.get(key) ?? [], link.written]);
  }
  if (raws.size === 0) return body2;
  const seen = /* @__PURE__ */ new Map();
  const replacements = [];
  for (const { node: node2, outer } of destinations(body2)) {
    const list2 = raws.get(node2.url);
    if (list2 === void 0) continue;
    const index2 = seen.get(node2.url) ?? 0;
    seen.set(node2.url, index2 + 1);
    replacements.push({ ...outer, text: list2[Math.min(index2, list2.length - 1)] });
  }
  return replaceRanges(body2, replacements);
}
function findFileLinks(documentPath2, body2, isFile) {
  const result = [];
  for (const { node: node2, range, outer } of destinations(body2)) {
    const target = resolveTarget(documentPath2, node2.url);
    if (target === null || !isFile(target)) continue;
    const cut = node2.url.search(/[?#]/);
    result.push({ ...range, written: body2.slice(outer.from, outer.to), target, suffix: cut === -1 ? "" : node2.url.slice(cut) });
  }
  return result;
}
function destinations(body2) {
  const result = [];
  visit(parse2(body2), (node2) => {
    if (node2.type !== "link" && node2.type !== "image" && node2.type !== "definition") return;
    const found = destinationRange(body2, node2);
    if (found !== null) result.push({ node: node2, range: { from: found.from, to: found.to }, outer: { from: found.outerFrom, to: found.outerTo } });
  });
  return result.sort((a, b) => a.range.from - b.range.from);
}
function replaceRanges(text4, replacements) {
  let result = text4;
  for (const replacement of [...replacements].sort((a, b) => b.from - a.from)) {
    result = result.slice(0, replacement.from) + replacement.text + result.slice(replacement.to);
  }
  return result;
}
function destinationRange(body2, node2) {
  const nodeEnd = end(node2);
  const opener = node2.type === "definition" ? "]:" : "](";
  let found = null;
  for (let at = body2.indexOf(opener, start(node2)); at !== -1 && at < nodeEnd; at = body2.indexOf(opener, at + 1)) {
    const range = destinationAt(body2, at + 2, nodeEnd);
    if (range === null || parsedDestination(body2.slice(range.outerFrom, range.outerTo)) !== node2.url) continue;
    found = range;
    if (node2.type === "definition") break;
  }
  return found;
}
function destinationAt(body2, position2, limit) {
  while (position2 < limit && /[ \t\r\n]/.test(body2[position2])) position2 += 1;
  if (body2[position2] === "<") {
    const close = body2.indexOf(">", position2 + 1);
    return close === -1 || close > limit ? null : { from: position2 + 1, to: close, outerFrom: position2, outerTo: close + 1 };
  }
  const from = position2;
  let depth2 = 0;
  while (position2 < limit) {
    const char = body2[position2];
    if (char === "\\") {
      position2 += 2;
      continue;
    }
    if (/\s/.test(char)) break;
    if (char === "(") depth2 += 1;
    if (char === ")") {
      if (depth2 === 0) break;
      depth2 -= 1;
    }
    position2 += 1;
  }
  const to = Math.min(position2, limit);
  return to > from ? { from, to, outerFrom: from, outerTo: to } : null;
}
function parsedDestination(destination2) {
  const paragraph = parse2(`[x](${destination2})`).children[0];
  const link = paragraph?.type === "paragraph" ? paragraph.children[0] : void 0;
  return link?.type === "link" ? link.url : void 0;
}
var CONTENT_TYPES = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  bmp: "image/bmp",
  ico: "image/x-icon",
  svg: "image/svg+xml",
  pdf: "application/pdf",
  zip: "application/zip",
  gz: "application/gzip",
  tar: "application/x-tar",
  csv: "text/csv",
  txt: "text/plain",
  json: "application/json",
  xml: "application/xml",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  otf: "font/otf",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  mp4: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime"
};
function contentTypeOf(path2) {
  const base = posix2.basename(path2);
  const dot = base.lastIndexOf(".");
  const extension2 = dot <= 0 ? "" : base.slice(dot + 1).toLowerCase();
  return CONTENT_TYPES[extension2] ?? "application/octet-stream";
}
function sha2562(content4) {
  return createHash3("sha256").update(content4).digest("hex");
}
function compare2(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

// src/initial-sync/run.ts
async function readPlanSources(context, options = {}) {
  const { git, mapping, linear } = context;
  const files = [...mapping.documents, ...mapping.leftOut];
  const blobs = await readBlobs(git, files.map((file) => file.oid));
  const texts = new Map(files.map((file) => [file.path, blobs.get(file.oid).toString("utf8")]));
  const places = [];
  const documents = /* @__PURE__ */ new Map();
  const containers = await readContainerDocuments(context);
  if (options.withContent) {
    const liveIds = [...new Set([...containers.values()].flat().filter((document4) => !document4.trashed && document4.archivedAt === null).map((document4) => document4.id))];
    for (const document4 of await linear.getDocuments(liveIds, { withContent: true })) documents.set(document4.id, document4);
  }
  for (const { place } of annotatedPlaces(mapping.zones)) {
    const listed = containers.get(containerKey(context, place));
    for (const document4 of listed) if (!documents.has(document4.id)) documents.set(document4.id, document4);
    places.push({ place, documents: listed });
  }
  return { input: { mapping, texts, places, facts: linear.facts }, documents, containers };
}
async function planFromRepository(context, cap) {
  const sources = await readPlanSources(context);
  const plan = planInitialSync(sources.input);
  plan.capacity = assessCapacity(context, sources.containers, plan.create, cap);
  const uploads = await readUploads(context.git, context.fetched.state.uploads);
  return leaveOutAtWrite(plan, await predictUploadLeaveOuts(context.git, context.fetched.tracked, plan, sources.input.texts, uploads));
}

// src/sync/recorded.ts
var RECORDED = /^Document-recorded: (\S+) (\S+)$/gm;
function recordedTime(updatedAt) {
  const time = new Date(updatedAt);
  if (!Number.isFinite(time.getTime())) throw new Error("a document has an invalid update time");
  return time.toISOString();
}
function recordedTrailers(recorded) {
  return [...recorded].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([id, time]) => `Document-recorded: ${id} ${recordedTime(time)}`);
}
function withRecorded(message, recorded) {
  return recorded.size === 0 ? message : `${message}

${recordedTrailers(recorded).join("\n")}`;
}
async function readRecorded(git, ids) {
  if (ids === null) return /* @__PURE__ */ new Map();
  const cursor = (await git.text(["log", "-1", "--format=%H", "--grep=^Capture-through:", ids])).trim();
  const log = await git.text(["log", "--format=%B%x00", cursor === "" ? ids : `${cursor}..${ids}`]);
  const recorded = /* @__PURE__ */ new Map();
  for (const message of log.split("\0")) {
    const seen = /* @__PURE__ */ new Map();
    for (const match of message.matchAll(RECORDED)) seen.set(match[1], match[2]);
    for (const [id, time] of seen) if (!recorded.has(id)) recorded.set(id, time);
  }
  return recorded;
}

// src/initial-sync/confirm.ts
var FINAL_IDS_MESSAGE = "Initial sync: document ids";
var KEPT_ANNOTATION = /^Kept-annotation: (".*")$/gm;
function keptAnnotationTrailer(path2) {
  return `Kept-annotation: ${JSON.stringify(path2)}`;
}
async function readKeptAnnotations(git, ids) {
  if (ids === null) return /* @__PURE__ */ new Set();
  const log = await git.text(["log", "--format=%B", "--fixed-strings", `--grep=${FINAL_IDS_MESSAGE}`, "-1", ids]);
  if (log.split("\n")[0] !== FINAL_IDS_MESSAGE) return /* @__PURE__ */ new Set();
  return new Set([...log.matchAll(KEPT_ANNOTATION)].map((match) => JSON.parse(match[1])));
}
var RECORD_MESSAGE = "Initial sync: Linear's state";
var SYNC_IDENTITY = Object.freeze({ name: "mdbisync", email: "mdbisync@sync.invalid" });
var PROGRESS_BATCH = 25;
var StateMovedError = class extends Error {
  constructor() {
    super("a state ref moved while the run was writing");
    this.name = "StateMovedError";
  }
};
async function confirmInitialSync(context, options) {
  const { git, fetched, targets, linear } = context;
  const transforms = options.transforms ?? [];
  const identity = options.identity ?? SYNC_IDENTITY;
  const batch = Math.max(1, options.progressBatch ?? PROGRESS_BATCH);
  const stopAfter = "stopAfterDocuments" in options ? options.stopAfterDocuments : testStopAfterDocuments();
  const checkpoint2 = options.checkpoint ?? ((name) => checkpoint(name));
  const newId = options.newId ?? randomUUID;
  const sources = await readPlanSources(context, { withContent: true });
  const plan = planInitialSync(sources.input);
  plan.capacity = assessCapacity(context, sources.containers, plan.create, options.documentCap);
  const texts = sources.input.texts;
  const expected = { ...fetched.state };
  const resumed = await readInitialSyncProgress(git, expected.ids) !== null;
  const previous3 = await readIds(git, expected.ids);
  const writtenBefore = resumed ? await readWrittenHashes(git, expected.ids) : /* @__PURE__ */ new Map();
  const sentHashes = new Map(writtenBefore);
  const ids = resumed ? new Map(previous3) : /* @__PURE__ */ new Map();
  const uploads = await readUploads(git, expected.uploads);
  const uploadsAtStart = uploads.size;
  const stored = /* @__PURE__ */ new Map();
  const sent = /* @__PURE__ */ new Map();
  const result = {
    complete: false,
    resumed,
    created: [],
    overwritten: [],
    unchanged: [],
    skippedCompleted: [],
    trashed: [],
    leftOutAtWrite: [],
    failed: [],
    notAttempted: [],
    progressPushes: 0,
    progressRecorded: true,
    record: null
  };
  if (capacityBlocked(plan.capacity)) {
    result.code = "container-cap";
    result.notAttempted = [...plan.create, ...plan.overwrite, ...plan.trash].map((entry) => entry.path).sort();
    return { plan, result };
  }
  const rememberedDocuments = /* @__PURE__ */ new Map();
  const remember = (path2, document4) => {
    const before = previous3.get(path2);
    ids.set(path2, before !== void 0 && before.id === document4.id && before.saved !== void 0 ? { id: document4.id, saved: before.saved } : { id: document4.id });
    stored.set(path2, document4.content ?? "");
    rememberedDocuments.set(path2, document4);
  };
  let unpushed = 0;
  let uploadsPushed = uploads.size;
  const pushProgress = async () => {
    const updates = [];
    const idsCommit = await commitIds(git, expected.ids, ids, identity, {
      message: initialSyncProgressMessage(fetched.tracked),
      always: true,
      written: sentHashes
    });
    updates.push({ ref: stateRef(options.config, "ids"), expected: expected.ids, next: idsCommit });
    if (uploads.size !== uploadsAtStart || expected.uploads !== null) {
      const uploadsCommit = await commitUploads(git, expected.uploads, uploads, identity);
      updates.push({ ref: stateRef(options.config, "uploads"), expected: expected.uploads, next: uploadsCommit });
    }
    const pushed = await pushAtomic(git, options.config, updates);
    if (!pushed.ok) throw new StateMovedError();
    expected.ids = idsCommit;
    if (updates.length > 1) expected.uploads = updates[1].next;
    result.progressPushes += 1;
    unpushed = 0;
    uploadsPushed = uploads.size;
  };
  const work = [
    ...plan.overwrite.map((entry) => ({ kind: "overwrite", entry })),
    ...plan.create.map((entry) => ({ kind: "create", entry }))
  ].sort((a, b) => compare3(a.entry.path, b.entry.path));
  const documentIds = /* @__PURE__ */ new Map();
  for (const entry of plan.overwrite) documentIds.set(entry.path, entry.documentId);
  const reserved = await readReservedIds(git, expected.ids);
  const saved = /* @__PURE__ */ new Map();
  for (const entry of plan.create) {
    const chosen = (resumed ? previous3.get(entry.path)?.id : void 0) ?? reserved.get(entry.path);
    if (chosen !== void 0 && !sources.documents.has(chosen)) saved.set(entry.path, chosen);
  }
  const taken = /* @__PURE__ */ new Set();
  if (saved.size > 0) for (const document4 of await linear.getDocuments([...new Set(saved.values())])) taken.add(document4.id);
  for (const entry of plan.create) {
    const chosen = saved.get(entry.path);
    documentIds.set(entry.path, chosen !== void 0 && !taken.has(chosen) ? chosen : newId());
    ids.set(entry.path, { id: documentIds.get(entry.path) });
  }
  try {
    for (const transform of transforms) await transform.prepare?.({ git, tracked: fetched.tracked, linear, plan, uploads, documentIds });
    let written = 0;
    let beforeWriteReached = false;
    for (let index2 = 0; index2 < work.length; index2 += 1) {
      const item = work[index2];
      const { path: path2 } = item.entry;
      const stop = linear.stopped ?? (stopAfter !== void 0 && written >= stopAfter ? { kind: "test-threshold", documents: stopAfter } : void 0);
      if (stop !== void 0) {
        result.stopped = stop;
        result.notAttempted = work.slice(index2).map((rest) => rest.entry.path);
        break;
      }
      const document4 = item.kind === "overwrite" ? sources.documents.get(item.entry.documentId) : void 0;
      if (item.kind === "overwrite" && document4 === void 0) throw new Error(`the planned document for ${path2} was not listed`);
      try {
        const source = splitFile(texts.get(path2)).body;
        const body2 = await transformBody(transforms, path2, source);
        const hash = sha2563(body2);
        sent.set(path2, body2);
        if (document4 !== void 0 && resumed && previous3.get(path2)?.id === document4.id && writtenBefore.get(path2) === hash) {
          result.skippedCompleted.push(path2);
          sentHashes.set(path2, hash);
          remember(path2, document4);
          continue;
        }
        if (document4 !== void 0 && (holdsBody(document4.content ?? "", body2) || holdsBody(fixText(restoreBody(transforms, path2, document4.content ?? "", body2)), source))) {
          result.unchanged.push(path2);
          remember(path2, document4);
          continue;
        }
        if (!beforeWriteReached) {
          beforeWriteReached = true;
          await checkpoint2("before-write");
        }
        if (item.kind === "create") {
          const title = item.entry.title.normalize("NFC");
          const id = documentIds.get(path2);
          const created = await linear.createDocument(placeId(targets, item.entry.place), { id, title, content: body2 });
          remember(path2, created);
          sentHashes.set(path2, hash);
          result.created.push(path2);
          await checkpoint2("document-created-before-ids-push");
        } else {
          const updated = await linear.updateDocument(item.entry.documentId, { content: body2 });
          remember(path2, updated);
          sentHashes.set(path2, hash);
          result.overwritten.push(path2);
        }
        written += 1;
        unpushed += 1;
      } catch (error) {
        if (error instanceof LeaveOutError) {
          result.leftOutAtWrite.push(error.files.length > 0 ? { path: path2, rule: error.rule, files: [...error.files] } : { path: path2, rule: error.rule });
          continue;
        }
        if (error instanceof DocumentTooLongError) {
          result.leftOutAtWrite.push({ path: path2, rule: "content-too-long" });
          continue;
        }
        if (error instanceof LinearStoppedError) {
          result.stopped = error.reason;
          result.notAttempted = work.slice(index2).map((rest) => rest.entry.path);
          break;
        }
        if (error instanceof LinearReadBackError) {
          ids.set(path2, { id: error.document.id });
          unpushed += 1;
        }
        if (error instanceof LinearError) {
          result.failed.push({ path: path2, operation: error.operation, error: describeLinearError(error) });
          continue;
        }
        throw error;
      }
      if (unpushed >= batch) await pushProgress();
    }
    const writesDone = result.stopped === void 0 && result.failed.length === 0;
    if (writesDone) {
      for (let index2 = 0; index2 < plan.trash.length; index2 += 1) {
        const entry = plan.trash[index2];
        if (linear.stopped !== void 0) {
          result.stopped = linear.stopped;
          result.notAttempted = plan.trash.slice(index2).map((rest) => rest.path);
          break;
        }
        try {
          await linear.trashDocument(entry.documentId);
          result.trashed.push(entry.path);
        } catch (error) {
          if (error instanceof LinearStoppedError) {
            result.stopped = error.reason;
            result.notAttempted = plan.trash.slice(index2).map((rest) => rest.path);
            break;
          }
          if (error instanceof LinearError) {
            result.failed.push({ path: entry.path, operation: error.operation, error: describeLinearError(error) });
            continue;
          }
          throw error;
        }
      }
    }
    if (result.stopped !== void 0 || result.failed.length > 0) {
      if (unpushed > 0 || uploads.size !== uploadsPushed || await readInitialSyncProgress(git, expected.ids) === null) await pushProgress();
      result.code = result.stopped !== void 0 ? "stopped" : "write-failed";
      return { plan, result };
    }
    await checkpoint2("after-write-before-record");
    const recorded = await record();
    if (recorded === null) {
      result.code = "state-moved";
      result.progressRecorded = unpushed === 0;
      return { plan, result };
    }
    result.record = recorded;
    result.complete = true;
    return { plan, result };
  } catch (error) {
    if (error instanceof StateMovedError) {
      result.code = "state-moved";
      result.progressRecorded = unpushed === 0;
      return { plan, result };
    }
    if (unpushed > 0 || uploads.size !== uploadsPushed) await pushProgress().catch(() => void 0);
    throw error;
  }
  async function record() {
    const synced = /* @__PURE__ */ new Set([...result.created, ...result.overwritten, ...result.unchanged, ...result.skippedCompleted]);
    const finalIds = new Map([...ids].filter(([path2]) => synced.has(path2)));
    const changes = /* @__PURE__ */ new Map();
    const reformatted = [];
    for (const path2 of [...synced].sort(compare3)) {
      const text4 = texts.get(path2);
      const file = splitFile(text4).head + restoreBody(transforms, path2, stored.get(path2) ?? "", sent.get(path2));
      if (file !== text4) {
        changes.set(path2, file);
        reformatted.push(path2);
      }
    }
    const tracked = fetched.tracked;
    let linearCommit = await commitTree(git, { parents: [tracked], base: tracked, changes, message: RECORD_MESSAGE, identity, skipIfUnchanged: false });
    if (expected.linear !== null && await sameRecord(expected.linear, linearCommit)) linearCommit = expected.linear;
    const created = new Set(plan.create.map((entry) => entry.path));
    const stillReserved = new Map(
      result.leftOutAtWrite.filter(({ path: path2 }) => created.has(path2)).map(({ path: path2 }) => [path2, documentIds.get(path2)])
    );
    const entries = new Map([...plan.create, ...plan.overwrite].map((entry) => [entry.path, entry]));
    const recorded = new Map(
      [...result.created, ...result.overwritten, ...result.unchanged].flatMap((path2) => {
        const document4 = rememberedDocuments.get(path2);
        const entry = entries.get(path2);
        if (document4 === void 0 || entry === void 0) return [];
        const where = placeId(targets, entry.place);
        const placed = "projectId" in where ? document4.projectId === where.projectId : document4.projectId === null && document4.teamId === where.teamId;
        return placed && document4.title.normalize("NFC") === entry.title.normalize("NFC") ? [[document4.id, document4.updatedAt]] : [];
      })
    );
    const idsCommit = await commitIds(git, expected.ids, finalIds, identity, {
      reserved: stillReserved,
      message: withRecorded(FINAL_IDS_MESSAGE, recorded),
      always: await readInitialSyncProgress(git, expected.ids) !== null
    });
    const uploadsCommit = await commitUploads(git, expected.uploads, uploads, identity);
    const updates = [
      { ref: stateRef(options.config, "ids"), expected: expected.ids, next: idsCommit },
      { ref: stateRef(options.config, "uploads"), expected: expected.uploads, next: uploadsCommit },
      // Initial sync replaces `linear`: its new record does not descend from an earlier one.
      { ref: stateRef(options.config, "linear"), expected: expected.linear, next: linearCommit, replace: true }
    ];
    const pushed = await pushAtomic(git, options.config, updates);
    if (!pushed.ok) return null;
    const parents = (await git.text(["show", "-s", "--format=%P", linearCommit])).split(" ").filter(Boolean);
    const hasTrackedParent = parents.length === 1 && parents[0] === tracked;
    return { linear: linearCommit, moved: linearCommit !== expected.linear, reformatted, parents, hasTrackedParent };
  }
  async function sameRecord(a, b) {
    const describe2 = (oid) => git.text(["show", "-s", "--format=%T %P", oid]);
    return await describe2(a) === await describe2(b);
  }
}
function sha2563(text4) {
  return createHash4("sha256").update(text4, "utf8").digest("hex");
}
function holdsBody(content4, body2) {
  return sameMarkdown(content4, body2) || content4 === fixText(body2);
}
function compare3(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

// src/initial-sync/reverse.ts
import { posix as posix6 } from "node:path";

// src/pull-request/github.ts
var PullRequestError = class extends Error {
  /** GitHub's HTTP status; undefined when no answer came. */
  status;
  constructor(what, status, cause) {
    super(status === void 0 ? `GitHub did not answer while ${what}` : `GitHub answered HTTP ${status} while ${what}`, cause === void 0 ? void 0 : { cause });
    this.name = "PullRequestError";
    this.status = status;
  }
};
async function findOpenPullRequest(target, head, base) {
  const owner = target.repository.split("/")[0];
  const query = new URLSearchParams({ state: "open", head: `${owner}:${head}`, base, per_page: "10" });
  const answer = await request(target, "GET", `/pulls?${query.toString()}`);
  if (answer.status !== 200 || !Array.isArray(answer.json)) throw new PullRequestError("listing open pull requests", answer.status);
  const found = answer.json.map(toPullRequest).find((pr) => pr !== null && pr.head === head && pr.base === base);
  return found ?? null;
}
async function openPullRequest(target, spec) {
  const answer = await request(target, "POST", "/pulls", { title: spec.title, head: spec.head, base: spec.base, body: spec.body, maintainer_can_modify: false }, { kind: "opened", accepted: 201 });
  const opened = answer.status === 201 ? toPullRequest(answer.json) : null;
  if (opened === null) throw new PullRequestError("opening a pull request", answer.status);
  return opened;
}
async function updatePullRequest(target, number, text4) {
  const answer = await request(target, "PATCH", `/pulls/${number}`, { title: text4.title, body: text4.body }, { kind: "updated", accepted: 200 });
  const updated = answer.status === 200 ? toPullRequest(answer.json) : null;
  if (updated === null) throw new PullRequestError("updating a pull request", answer.status);
  return updated;
}
async function closePullRequest(target, number) {
  const answer = await request(target, "PATCH", `/pulls/${number}`, { state: "closed" }, { kind: "closed", accepted: 200 });
  if (answer.status !== 200) throw new PullRequestError("closing a pull request", answer.status);
}
async function ensurePullRequest(target, spec) {
  const open = await findOpenPullRequest(target, spec.head, spec.base);
  if (open !== null) {
    if (open.title === spec.title && open.body === spec.body) return { pullRequest: open, opened: false, updated: false };
    return { pullRequest: await updatePullRequest(target, open.number, spec), opened: false, updated: true };
  }
  return { pullRequest: await openPullRequest(target, spec), opened: true, updated: false };
}
function toPullRequest(value) {
  const pr = value;
  if (pr === null || typeof pr !== "object" || typeof pr.number !== "number") return null;
  if (typeof pr.head?.ref !== "string" || typeof pr.base?.ref !== "string") return null;
  return {
    number: pr.number,
    url: typeof pr.html_url === "string" ? pr.html_url : "",
    head: pr.head.ref,
    base: pr.base.ref,
    title: typeof pr.title === "string" ? pr.title : "",
    body: typeof pr.body === "string" ? pr.body : ""
  };
}
async function request(target, method, path2, body2, write) {
  const base = `${(target.apiUrl ?? DEFAULT_GITHUB_API_URL).replace(/\/+$/, "")}/repos/${target.repository}`;
  let status;
  let text4;
  try {
    const response = await (target.fetch ?? fetch)(`${base}${path2}`, {
      method,
      headers: {
        authorization: `Bearer ${target.token}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        ...body2 === void 0 ? {} : { "content-type": "application/json" }
      },
      ...body2 === void 0 ? {} : { body: JSON.stringify(body2) },
      signal: AbortSignal.any([AbortSignal.timeout(3e4), ...target.signal ? [target.signal] : []])
    });
    status = response.status;
    if (write !== void 0 && status === write.accepted) target.writes?.set(write.kind, (target.writes.get(write.kind) ?? 0) + 1);
    text4 = await response.text();
  } catch (error) {
    if (!isTransportError(error)) throw error;
    throw new PullRequestError(`sending ${method} to the pull request API`, void 0, error);
  }
  let json = null;
  try {
    json = JSON.parse(text4);
  } catch {
  }
  return { status, json };
}
function isTransportError(error) {
  if (error instanceof TypeError) return true;
  return error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
}

// src/pull-request/merge.ts
import { setTimeout as sleep2 } from "node:timers/promises";
var PASSING_CONCLUSIONS = /* @__PURE__ */ new Set(["success", "neutral", "skipped"]);
var MAX_PAGES = 10;
var PAGE_SIZE = 100;
async function readChecks(target, sha) {
  const failed2 = /* @__PURE__ */ new Set();
  const pending = /* @__PURE__ */ new Set();
  let seen = 0;
  let hasRuns = false;
  for (let page = 1; ; page += 1) {
    const answer2 = await request(target, "GET", `/commits/${sha}/check-runs?per_page=${PAGE_SIZE}&page=${page}`);
    const body2 = answer2.json;
    if (answer2.status !== 200 || body2 === null || typeof body2.total_count !== "number" || !Array.isArray(body2.check_runs)) {
      throw new PullRequestError("reading the check runs of the sync pull request", answer2.status);
    }
    hasRuns ||= body2.total_count > 0;
    for (const run of body2.check_runs) {
      const name = typeof run.name === "string" ? run.name : "unnamed check";
      if (run.status !== "completed") pending.add(name);
      else if (typeof run.conclusion !== "string" || !PASSING_CONCLUSIONS.has(run.conclusion)) failed2.add(name);
    }
    seen += body2.check_runs.length;
    if (seen >= body2.total_count) break;
    if (body2.check_runs.length === 0 || page === MAX_PAGES) {
      pending.add(`${body2.total_count - seen} more check runs`);
      break;
    }
  }
  const answer = await request(target, "GET", `/commits/${sha}/status?per_page=${PAGE_SIZE}`);
  const combined = answer.json;
  if (answer.status !== 200 || combined === null || typeof combined.total_count !== "number" || !Array.isArray(combined.statuses)) {
    throw new PullRequestError("reading the commit statuses of the sync pull request", answer.status);
  }
  if (combined.total_count > combined.statuses.length) pending.add(`${combined.total_count - combined.statuses.length} more commit statuses`);
  for (const status of combined.statuses) {
    const name = typeof status.context === "string" ? status.context : "unnamed status";
    if (status.state === "pending") pending.add(name);
    else if (status.state !== "success") failed2.add(name);
  }
  const sorted = (names) => [...names].sort();
  return { hasChecks: hasRuns || combined.total_count > 0, state: failed2.size > 0 ? "failed" : pending.size > 0 ? "pending" : "passed", failed: sorted(failed2), pending: sorted(pending) };
}
async function waitForChecks(target, sha, seconds, clock = { now: () => performance.now(), sleep: (ms) => sleep2(ms) }) {
  const started = clock.now();
  const deadline = started + seconds * 1e3;
  const signal = AbortSignal.any([AbortSignal.timeout(seconds * 1e3), ...target.signal ? [target.signal] : []]);
  let emptySince = null;
  let last = { state: "pending", failed: [], pending: [], hasChecks: false };
  for (let attempt = 0; attempt < Math.ceil(seconds / 5); attempt += 1) {
    if (clock.now() >= deadline) break;
    try {
      last = await readChecks({ ...target, signal }, sha);
    } catch (error) {
      if (signal.aborted && !target.signal?.aborted && error instanceof PullRequestError) break;
      throw error;
    }
    const now = clock.now();
    if (last.state === "failed") return last;
    if (now >= deadline) break;
    if (last.hasChecks) emptySince = null;
    else emptySince ??= now;
    if (now - started >= 15e3 && last.state === "passed" && (last.hasChecks || emptySince !== null && now - emptySince >= 15e3)) return last;
    await clock.sleep(Math.min(5e3, deadline - now));
  }
  return { ...last, state: "pending" };
}
var REASON_LENGTH = 300;
async function mergePullRequest(target, number, sha) {
  const answer = await request(target, "PUT", `/pulls/${number}/merge`, { merge_method: "merge", sha }, { kind: "merged", accepted: 200 });
  const body2 = answer.json;
  if (answer.status === 200 && body2 !== null && body2.merged === true && typeof body2.sha === "string") return { merged: true, sha: body2.sha };
  if (answer.status === 405 || answer.status === 409 || answer.status === 422) {
    return { merged: false, status: answer.status, reason: refusalReason(body2?.message) };
  }
  throw new PullRequestError("merging the sync pull request", answer.status);
}
function refusalReason(message) {
  if (typeof message !== "string") return "";
  const line2 = message.replace(/[`\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  const points = [...line2];
  return points.length > REASON_LENGTH ? `${points.slice(0, REASON_LENGTH - 1).join("")}\u2026` : line2;
}

// src/sync/assets.ts
import { createHash as createHash5 } from "node:crypto";
import { posix as posix3 } from "node:path";
var LIMIT = 10 * 1024 * 1024;
function isUpload(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && parsed.hostname === "uploads.linear.app" && parsed.username === "" && parsed.password === "" && parsed.port === "";
  } catch {
    return false;
  }
}
async function download(url, fetcher, reads) {
  if (!isUpload(url)) throw new Error("asset destination is not allowed");
  const key = uploadReadKey(url);
  const kept = reads?.take(key);
  if (kept !== void 0 && kept.body.length <= LIMIT) return { bytes: kept.body, type: kept.type };
  const response = await fetcher(url, { redirect: "manual", signal: AbortSignal.timeout(3e4) });
  if (response.status >= 300 && response.status < 400) throw new Error("asset redirect destination is not allowed");
  if (!response.ok || response.body === null || Number(response.headers.get("content-length") ?? 0) > LIMIT) throw new Error("asset could not be downloaded");
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > LIMIT) throw new Error("asset exceeds the download limit");
    chunks.push(Buffer.from(chunk));
  }
  const asset = { bytes: Buffer.concat(chunks), type: response.headers.get("content-type")?.split(";")[0]?.trim() ?? "" };
  reads?.keep(key, { status: response.status, type: asset.type, body: asset.bytes });
  return asset;
}
var EXTENSIONS = { "image/png": ".png", "image/jpeg": ".jpg", "image/gif": ".gif", "image/webp": ".webp", "image/svg+xml": ".svg", "image/avif": ".avif", "application/pdf": ".pdf" };
function createAssetCapture(git, config, base, fetcher = fetch, reads) {
  const hashPaths = /* @__PURE__ */ new Map();
  const pathHashes = /* @__PURE__ */ new Map();
  let indexed = false;
  const index2 = async () => {
    if (indexed) return;
    const entries = (await listTree(git, base)).filter((entry) => entry.type === "blob" && ["100644", "100755"].includes(entry.mode) && !entry.path.toLowerCase().endsWith(".md"));
    for (let at = 0; at < entries.length; ) {
      const batch = [];
      let bytes = 0;
      while (at < entries.length && (batch.length === 0 || bytes + (entries[at].size ?? 0) <= 32 * 1024 * 1024)) {
        const entry = entries[at++];
        bytes += entry.size ?? 0;
        batch.push(entry);
      }
      const blobs = await readBlobs(git, batch.map((entry) => entry.oid));
      for (const entry of batch) {
        const blob = blobs.get(entry.oid);
        const hash = parseLfsPointer(blob)?.oid ?? createHash5("sha256").update(blob).digest("hex");
        hashPaths.set(hash, entry.path);
        pathHashes.set(entry.path, hash);
      }
    }
    indexed = true;
  };
  const readable = /* @__PURE__ */ new Map();
  const canRead = async (path2) => {
    if (!readable.has(path2)) readable.set(path2, (await readFiles(git, config, base, [path2])).get(path2)?.ok === true);
    return readable.get(path2);
  };
  const downloaded = /* @__PURE__ */ new Map();
  return async (path2, body2, uploads, previousBody, previousPath = path2) => {
    const files = /* @__PURE__ */ new Map();
    const additions = /* @__PURE__ */ new Map();
    const cachedUrls = [...uploads.values()];
    const knownUpload = (url) => cachedUrls.some((known) => url === known || url.startsWith(`${known}?`) || url.startsWith(`${known}#`));
    if (!destinations(body2).some(({ node: node2 }) => isUpload(node2.url) || knownUpload(node2.url))) return { body: body2, files, uploads: additions };
    await index2();
    const preferredPaths = /* @__PURE__ */ new Map();
    if (previousBody !== void 0) {
      const written = [];
      for (const link of findFileLinks(previousPath, previousBody, (target) => pathHashes.has(target))) {
        if (!await canRead(link.target)) continue;
        const hash = pathHashes.get(link.target);
        if (!preferredPaths.has(hash)) preferredPaths.set(hash, link.target);
        const raw = previousPath === path2 ? link.written : posix3.relative(posix3.dirname(path2), link.target).split("/").map(encodeURIComponent).join("/") + link.suffix;
        written.push({ written: previousPath !== path2 && link.written.startsWith("<") ? `<${raw}>` : raw, hash, suffix: link.suffix });
      }
      const spellings = /* @__PURE__ */ new Map();
      for (const link of written) {
        const url = uploads.get(link.hash);
        if (url === void 0) continue;
        const key = url + link.suffix;
        spellings.set(key, [...spellings.get(key) ?? [], link]);
      }
      const occurrences = /* @__PURE__ */ new Map();
      const shaped = [];
      for (const { node: node2, outer } of destinations(body2)) {
        const choices = spellings.get(node2.url);
        if (choices === void 0) continue;
        const index3 = occurrences.get(node2.url) ?? 0;
        occurrences.set(node2.url, index3 + 1);
        const link = choices[Math.min(index3, choices.length - 1)];
        const inner = link.written.startsWith("<") ? link.written.slice(1, -1) : link.written;
        shaped.push({ ...link, written: body2[outer.from] === "<" ? `<${inner}>` : inner.replace(/\s/g, encodeURIComponent) });
      }
      body2 = restoreFileLinks(body2, shaped, new Map(uploads));
    }
    const references = destinations(body2).filter(({ node: node2 }) => isUpload(node2.url) || knownUpload(node2.url));
    const replacements = [];
    for (const { node: node2, range } of references) {
      const cached = cachedUrls.filter((known) => node2.url === known || node2.url.startsWith(`${known}?`) || node2.url.startsWith(`${known}#`)).sort((a, b) => b.length - a.length)[0];
      const hashAt = node2.url.indexOf("#");
      const url = cached ?? (hashAt === -1 ? node2.url : node2.url.slice(0, hashAt));
      const suffix = cached === void 0 ? hashAt === -1 ? "" : node2.url.slice(hashAt) : node2.url.slice(cached.length);
      let hash = [...uploads].find(([, known]) => known === url)?.[0];
      let assetPath = hash === void 0 ? void 0 : preferredPaths.get(hash) ?? hashPaths.get(hash);
      if (assetPath !== void 0) {
        if (!await canRead(assetPath)) assetPath = void 0;
      }
      if (assetPath === void 0) {
        let asset = downloaded.get(url);
        if (asset === void 0) {
          asset = await download(url, fetcher, reads);
          downloaded.set(url, asset);
        }
        hash = createHash5("sha256").update(asset.bytes).digest("hex");
        assetPath = preferredPaths.get(hash) ?? hashPaths.get(hash);
        if (assetPath === void 0) {
          const extension2 = posix3.extname(new URL(url).pathname).toLowerCase();
          const suffix2 = EXTENSIONS[asset.type] ?? (/^\.[a-z0-9]{1,8}$/.test(extension2) && extension2 !== ".md" ? extension2 : ".bin");
          assetPath = posix3.join(posix3.dirname(path2), `${hash}${suffix2}`);
          if (pathHashes.has(assetPath)) throw new Error("asset destination already exists");
        }
        files.set(assetPath, asset.bytes);
      }
      additions.set(hash, url);
      replacements.push({ ...range, text: posix3.relative(posix3.dirname(path2), assetPath).split("/").map(encodeURIComponent).join("/") + suffix });
    }
    let result = body2;
    for (const replacement of replacements.sort((a, b) => b.from - a.from)) result = result.slice(0, replacement.from) + replacement.text + result.slice(replacement.to);
    return { body: result, files, uploads: additions };
  };
}

// src/sync/security.ts
import { spawn as spawn2 } from "node:child_process";
import { mkdtemp as mkdtemp2, mkdir as mkdir2, writeFile as writeFile2, readFile as readFile2, rm as rm2 } from "node:fs/promises";
import { tmpdir as tmpdir2 } from "node:os";
import { dirname, join as join5 } from "node:path";
function runHooks(dir, args, env) {
  return new Promise((resolve3) => {
    const child = spawn2("pre-commit", args, { cwd: dir, env: { ...env, PRE_COMMIT_COLOR: "never", GIT_TERMINAL_PROMPT: "0" }, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    const collect = (chunk) => {
      if (output.length < 2e6) output += chunk.toString("utf8");
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    const timer = setTimeout(() => child.kill("SIGKILL"), 12e4);
    child.on("error", () => {
      clearTimeout(timer);
      resolve3({ code: -1, output: "" });
    });
    child.on("close", (code2) => {
      clearTimeout(timer);
      resolve3({ code: code2 ?? -1, output });
    });
  });
}
async function securityHookIds(git, tracked) {
  const read = await git.run(["cat-file", "blob", `${tracked}:${PRE_COMMIT_CONFIG}`], { okCodes: [0, 128] });
  const config = readHookConfig(read.code === 0 ? read.stdout.toString("utf8") : null);
  if (config.invalid !== void 0) throw new Error("invalid security hook configuration");
  return config.hooks.filter((hook) => hook.alias === SECURITY_ALIAS).map((hook) => hook.id);
}
async function securityGate(git, tracked, options = {}) {
  const env = options.env ?? { PATH: process.env.PATH, HOME: process.env.HOME, LANG: "C.UTF-8" };
  const hooks = await securityHookIds(git, tracked);
  if (hooks.length > 0 && (await runHooks(git.dir, ["--version"], env)).code !== 0) throw new Error("security hooks require pre-commit on PATH; install pre-commit before capture");
  let dir;
  let scratch;
  let baseline;
  const close = async () => {
    if (dir !== void 0) await rm2(dir, { recursive: true, force: true });
    dir = void 0;
  };
  return {
    configured: hooks.length > 0,
    close,
    async check(files) {
      if (hooks.length === 0) return [];
      try {
        if (dir === void 0) {
          dir = await mkdtemp2(join5(tmpdir2(), "capture-security-"));
          scratch = new Git(dir);
          await scratch.run(["init", "--quiet"]);
          const entries = (await listTree(git, tracked)).filter((entry) => entry.type === "blob" && ["100644", "100755"].includes(entry.mode));
          for (let at = 0; at < entries.length; at += 32) {
            const batch = entries.slice(at, at + 32);
            const blobs = await readBlobs(git, batch.map((entry) => entry.oid));
            for (const entry of batch) {
              checkRepoPath(entry.path);
              await mkdir2(dirname(join5(dir, entry.path)), { recursive: true });
              await writeFile2(join5(dir, entry.path), blobs.get(entry.oid), { mode: entry.mode === "100755" ? 493 : 420 });
            }
          }
          await scratch.run(["add", "--all"]);
          baseline = await scratch.text(["write-tree"]);
        }
        await scratch.run(["read-tree", "--reset", "-u", baseline]);
        await scratch.run(["clean", "-fdx", "--quiet"]);
        for (const [path2, content4] of files) {
          checkRepoPath(path2);
          if (path2 === PRE_COMMIT_CONFIG) return [{ hook: SECURITY_ALIAS, line: 1 }];
          await mkdir2(dirname(join5(dir, path2)), { recursive: true });
          await writeFile2(join5(dir, path2), content4);
        }
        await scratch.run(["add", "--force", "--", ...files.keys()]);
        const findings = [];
        let ran = false;
        for (const stage of ["pre-commit", "pre-push"]) {
          const result = await runHooks(dir, ["run", SECURITY_ALIAS, "--hook-stage", stage, "--files", ...files.keys()], env);
          if (result.code !== 0 && result.output.trim() === `No hook with id \`security\` in stage \`${stage}\``) continue;
          ran = true;
          if (result.code !== 0) {
            const failed2 = hooks.filter((id) => result.output.includes(`- hook id: ${id}
`));
            const escaped = [...files.keys()].map((path2) => path2.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
            const located = new RegExp(`(?:${escaped.join("|")}):(\\d+)(?::|\\b)`, "g");
            const matches = [...result.output.matchAll(located)];
            const lines2 = matches.map((match) => Number(match[1])).filter((line2) => Number.isSafeInteger(line2) && line2 > 0);
            for (const hook of failed2.length > 0 ? failed2 : [SECURITY_ALIAS]) findings.push({ hook, line: lines2[0] ?? 1 });
          }
        }
        if (!ran) findings.push({ hook: SECURITY_ALIAS, line: 1 });
        for (const [path2, content4] of files) {
          const after = await readFile2(join5(dir, path2)).catch(() => null);
          if (after === null || !after.equals(Buffer.from(content4))) findings.push({ hook: SECURITY_ALIAS, line: 1 });
        }
        return findings;
      } catch {
        return [{ hook: SECURITY_ALIAS, line: 1 }];
      }
    }
  };
}

// src/sync/paths.ts
import { createHash as createHash6 } from "node:crypto";
import { posix as posix4 } from "node:path";
var PATH_RULE = "percent-encode-unsafe-segments";
function titlePath(title) {
  return title.normalize("NFC").split("/").map((part) => {
    let safe = part.replace(/[%\\\u0000-\u001f\u007f:*?"<>|]/g, (char) => char === "*" ? "%2A" : encodeURIComponent(char));
    if (safe === "" || safe === "." || safe === ".." || safe.toLowerCase() === ".git" || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(safe)) {
      safe = safe === "" ? "%00" : `%${safe.charCodeAt(0).toString(16).toUpperCase()}${safe.slice(1)}`;
    }
    safe = safe.replace(/[. ]+$/, (suffix) => [...suffix].map((char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`).join(""));
    if (Buffer.byteLength(safe) > 180) safe = `${[...safe].slice(0, 40).join("")}~${createHash6("sha256").update(part).digest("hex").slice(0, 16)}`;
    return safe;
  }).join("/");
}
function pathKey(path2) {
  return path2.normalize("NFC").toLowerCase();
}
function documentPath(folder, title, id, occupied, previous3, invalid = () => false) {
  const stem = posix4.join(folder, titlePath(title));
  const keys = [...occupied].map(pathKey);
  const conflicts = (path2) => invalid(path2) || keys.some((key) => key === pathKey(path2) || key.startsWith(`${pathKey(path2)}/`) || pathKey(path2).startsWith(`${key}/`));
  let candidate = `${stem}.md`;
  const raw = `${folder === "" ? "" : `${folder}/`}${title}.md`;
  if (previous3 === raw && !conflicts(previous3)) return previous3;
  const suffix = createHash6("sha256").update(id).digest("hex").slice(0, 12);
  const flattened = titlePath(title).replaceAll("/", "%2F");
  const flat = Buffer.byteLength(flattened) > 180 ? `${[...flattened].slice(0, 40).join("")}~${createHash6("sha256").update(title).digest("hex").slice(0, 16)}` : flattened;
  if (previous3 !== void 0 && !conflicts(previous3)) {
    const prefix = posix4.join(folder, `${flat}~${suffix}`);
    if (previous3 === `${prefix}.md` || previous3.startsWith(`${prefix}-`) && /^\d+\.md$/.test(previous3.slice(prefix.length + 1))) return previous3;
  }
  if (!conflicts(candidate)) return candidate;
  for (let index2 = 0; ; index2 += 1) {
    candidate = posix4.join(folder, `${flat}~${suffix}${index2 === 0 ? "" : `-${index2}`}.md`);
    if (!conflicts(candidate)) return candidate;
    if (index2 > occupied.size + 1) throw new Error("no safe destination for a document");
  }
}

// src/initial-sync/links.ts
import { posix as posix5 } from "node:path";
function documentUrlBase(urlKey) {
  return `https://linear.app/${urlKey}/document`;
}
function resolveRelative(fromPath, url) {
  if (url === "" || url.startsWith("#") || url.startsWith("//") || /^[a-z][a-z0-9+.-]*:/i.test(url)) return void 0;
  const hash = url.indexOf("#");
  const target = hash === -1 ? url : url.slice(0, hash);
  const fragment = hash === -1 ? void 0 : url.slice(hash + 1);
  if (target === "" || target.includes("?")) return void 0;
  let decoded;
  try {
    decoded = decodeURIComponent(target);
  } catch {
    return void 0;
  }
  const joined = decoded.startsWith("/") ? decoded.slice(1) : posix5.join(posix5.dirname(fromPath), decoded);
  const path2 = posix5.normalize(joined);
  if (path2 === "." || path2.startsWith("../") || path2 === ".." || path2.endsWith("/")) return void 0;
  return { path: path2, fragment };
}
function relativeLink(fromPath, toPath) {
  const relative3 = posix5.relative(posix5.dirname(fromPath), toPath);
  return relative3.split("/").map((segment) => encodeURIComponent(segment)).join("/");
}
function linkDestinations(body2) {
  const tree = parse2(body2);
  const imageLabels = /* @__PURE__ */ new Set();
  visit(tree, (node2) => {
    if (node2.type === "imageReference") imageLabels.add(node2.identifier);
  });
  const found = [];
  visit(tree, (node2) => {
    if (node2.type !== "link" && node2.type !== "definition") return;
    if (node2.type === "definition" && imageLabels.has(node2.identifier)) return;
    const span = destinationSpan(body2, node2);
    if (span !== void 0 && destinationUrl(body2.slice(span.from, span.to)) === node2.url) found.push({ ...span, url: node2.url });
  });
  return found.sort((a, b) => a.from - b.from);
}
function destinationUrl(raw) {
  const paragraph = parse2(`[x](${raw})`).children[0];
  const link = paragraph?.type === "paragraph" && paragraph.children.length === 1 ? paragraph.children[0] : void 0;
  return link?.type === "link" ? link.url : void 0;
}
function encodeFragment(fragment) {
  return fragment.replace(/[^A-Za-z0-9\-._~!$'*+,;=:@/?%]/gu, (char) => encodeURIComponent(char));
}
function rewrite(body2, replace2) {
  let result = "";
  let at = 0;
  for (const destination2 of linkDestinations(body2)) {
    const next = replace2(destination2);
    if (next === void 0) continue;
    result += body2.slice(at, destination2.from) + next;
    at = destination2.to;
  }
  return result + body2.slice(at);
}
function linksToLinear(body2, fromPath, map, seen) {
  const remember = (url, raw) => seen?.set(url, [...seen.get(url) ?? [], raw]);
  return rewrite(body2, (destination2) => {
    const original = body2.slice(destination2.from, destination2.to);
    if (destination2.url.startsWith(`${map.base}/`)) {
      remember(destination2.url, original);
      return void 0;
    }
    const target = resolveRelative(fromPath, destination2.url);
    if (target === void 0) return void 0;
    const id = map.ids.get(target.path);
    if (id === void 0) return void 0;
    const raw = `<${map.base}/${id}${target.fragment === void 0 ? "" : `#${encodeFragment(target.fragment)}`}>`;
    remember(destinationUrl(raw) ?? raw.slice(1, -1), original);
    return raw;
  });
}
var reversed = /* @__PURE__ */ new WeakMap();
function pathsById(ids) {
  let paths = reversed.get(ids);
  if (paths === void 0) {
    paths = new Map([...ids].map(([path2, id]) => [id, path2]));
    reversed.set(ids, paths);
  }
  return paths;
}
function hasDocumentLinks(body2, fromPath, ids) {
  return linkDestinations(body2).some((destination2) => {
    const target = resolveRelative(fromPath, destination2.url);
    return target !== void 0 && ids.has(target.path);
  });
}
function linksFromLinear(content4, fromPath, map, seen) {
  const paths = pathsById(map.ids);
  const prefix = `${map.base}/`;
  const used = /* @__PURE__ */ new Map();
  return rewrite(content4, (destination2) => {
    if (!destination2.url.startsWith(prefix)) return void 0;
    const index2 = used.get(destination2.url) ?? 0;
    used.set(destination2.url, index2 + 1);
    const known = seen?.get(destination2.url)?.[index2];
    if (known !== void 0) return known;
    const rest = destination2.url.slice(prefix.length);
    const hash = rest.indexOf("#");
    const id = hash === -1 ? rest : rest.slice(0, hash);
    const path2 = paths.get(id);
    if (path2 === void 0) return void 0;
    return `<${relativeLink(fromPath, path2)}${hash === -1 ? "" : rest.slice(hash)}>`;
  });
}
function destinationSpan(body2, node2) {
  const start2 = node2.position?.start.offset;
  const end2 = node2.position?.end.offset;
  if (start2 === void 0 || end2 === void 0) return void 0;
  let at;
  if (node2.type === "link") {
    if (body2[end2 - 1] !== ")") return void 0;
    const last = node2.children.at(-1);
    const textEnd = last?.position?.end.offset ?? start2 + 1;
    const open = body2.indexOf("](", textEnd);
    if (open === -1 || open >= end2) return void 0;
    at = open + 2;
  } else {
    let close = start2 + 1;
    while (close < end2 && body2[close] !== "]") close += body2[close] === "\\" ? 2 : 1;
    if (body2[close + 1] !== ":") return void 0;
    at = close + 2;
  }
  while (at < end2 && /[ \t\r\n]/.test(body2[at])) at += 1;
  if (body2[at] === "<") {
    let close = at + 1;
    while (close < end2 && body2[close] !== ">") close += body2[close] === "\\" ? 2 : 1;
    return close < end2 ? { from: at, to: close + 1 } : void 0;
  }
  let to = at;
  let depth2 = 0;
  while (to < end2) {
    const char = body2[to];
    if (char === "\\") {
      to += 2;
      continue;
    }
    if (/[ \t\r\n]/.test(char)) break;
    if (char === "(") depth2 += 1;
    if (char === ")") {
      if (depth2 === 0) break;
      depth2 -= 1;
    }
    to += 1;
  }
  return to > at ? { from: at, to } : void 0;
}
function linksLinearDocuments(content4) {
  return linkDestinations(content4).some((destination2) => isLinearDocumentUrl(destination2.url));
}
function isLinearDocumentUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return parsed.protocol === "https:" && parsed.hostname === "linear.app" && /^\/[^/]+\/document\//.test(parsed.pathname);
}
async function workspaceUrlKey(linear) {
  const data = await linear.request("WorkspaceUrlKey", "query", "query WorkspaceUrlKey { organization { urlKey } }");
  return data.organization.urlKey;
}
function documentLinks() {
  let context;
  let map;
  const rewritten = /* @__PURE__ */ new Map();
  return {
    name: "document-links",
    async prepare(run) {
      context = run;
    },
    async apply({ path: path2, body: body2 }) {
      if (context === void 0) throw new Error("document-links: apply before prepare");
      if (map === void 0) {
        if (!hasDocumentLinks(body2, path2, context.documentIds)) return body2;
        map = { base: documentUrlBase(await workspaceUrlKey(context.linear)), ids: context.documentIds };
      }
      const asWritten = /* @__PURE__ */ new Map();
      const written = linksToLinear(body2, path2, map, asWritten);
      if (written === body2) {
        rewritten.delete(path2);
        return body2;
      }
      const inLinearForm = /* @__PURE__ */ new Map();
      linksToLinear(fixText(body2), path2, map, inLinearForm);
      rewritten.set(path2, { asWritten, inLinearForm });
      return written;
    },
    restore({ path: path2, body: body2, kept }) {
      const entry = rewritten.get(path2);
      if (map === void 0 || entry === void 0) return body2;
      return linksFromLinear(body2, path2, map, kept ? entry.asWritten : entry.inLinearForm);
    }
  };
}

// src/initial-sync/reverse.ts
var REVERSE_RECORD_MESSAGE = INITIAL_SYNC_FROM_LINEAR_RECORD;
var PULL_REQUEST_TITLE = "Initial sync from Linear";
function planLinearToGit(input) {
  const plan = planInitialSync(input);
  const annotations = new Set(input.mapping.annotations.map((annotation) => annotation.readme));
  const result = { overwrite: plan.overwrite.map(entryOf), create: [], remove: [], kept: [], leftOut: [...plan.leftOut] };
  const folders = new Map(annotatedPlaces(input.mapping.zones).map(({ place, folder }) => [placeKey(place), folder]));
  const invalid = (place) => (candidate) => !landsInPlace(input.mapping, candidate, place);
  const folderOfPlace = (place) => folders.get(placeKey(place)) ?? "";
  const plainPath = (title, place) => `${posix6.join(folderOfPlace(place), titlePath(title))}.md`;
  const named = /* @__PURE__ */ new Map();
  const trash = [...plan.trash];
  const overwriteByPath = new Map(result.overwrite.map((entry) => [entry.path, entry]));
  for (const entry of plan.trash) {
    const plain = plainPath(entry.title, entry.place);
    const other = overwriteByPath.get(plain);
    if (other === void 0 || placeKey(other.place) !== placeKey(entry.place) || plainPath(other.title, other.place) === plain) continue;
    result.overwrite = result.overwrite.filter((candidate) => candidate !== other);
    const claimed = { path: plain, title: entry.title, place: entry.place, documentId: entry.documentId, fileTitle: other.fileTitle };
    result.overwrite.push(claimed);
    overwriteByPath.set(plain, claimed);
    named.set(entry.documentId, plain);
    trash.push({ path: plain, title: other.title, place: other.place, documentId: other.documentId });
  }
  const gitOnly = new Map(plan.create.map((entry) => [entry.path, entry]));
  const created = new Map(input.places.flatMap(({ documents }) => documents.map((document4) => [document4.id, document4.createdAt])));
  const documentsOldestFirst = trash.filter((entry) => !named.has(entry.documentId)).sort((a, b) => compare4(created.get(a.documentId) ?? "", created.get(b.documentId) ?? "") || compare4(a.documentId, b.documentId));
  for (const entry of documentsOldestFirst) {
    const folder = folderOfPlace(entry.place);
    const plain = plainPath(entry.title, entry.place);
    for (const [path2, file] of gitOnly) {
      if (path2 !== plain && !(path2.startsWith(folder === "" ? "" : `${folder}/`) && path2.includes("~"))) continue;
      if (placeKey(file.place) !== placeKey(entry.place)) continue;
      const others = new Set([...input.treePaths].filter((other) => other !== path2));
      if (documentPath(folder, entry.title, entry.documentId, others, path2, invalid(entry.place)) !== path2) continue;
      result.overwrite.push({ path: path2, title: entry.title, place: entry.place, documentId: entry.documentId, fileTitle: file.title });
      named.set(entry.documentId, path2);
      gitOnly.delete(path2);
      break;
    }
  }
  for (const entry of gitOnly.values()) {
    if (annotations.has(entry.path)) result.kept.push({ path: entry.path, reason: "annotation" });
    else result.remove.push(entry.path);
  }
  const removed = new Set(result.remove);
  const occupied = new Set([...input.treePaths].filter((path2) => !removed.has(path2)));
  for (const entry of documentsOldestFirst) {
    if (named.has(entry.documentId)) continue;
    const folder = folderOfPlace(entry.place);
    const path2 = documentPath(folder, entry.title, entry.documentId, occupied, void 0, invalid(entry.place));
    result.create.push({ path: path2, title: entry.title, place: entry.place, documentId: entry.documentId, fileTitle: posix6.relative(folder, path2).slice(0, -".md".length) });
    occupied.add(path2);
  }
  result.overwrite.sort((a, b) => compare4(a.path, b.path));
  result.create.sort((a, b) => compare4(a.path, b.path));
  result.remove.sort(compare4);
  result.leftOut.sort((a, b) => compare4(a.path, b.path));
  return result;
}
function landsInPlace(mapping, path2, place) {
  const zone = nearestZone(mapping.zones, folderOf(path2));
  if (zone === void 0) return false;
  const zonePlace = zone.project !== void 0 ? { kind: "project", team: zone.team, project: zone.project } : { kind: "team", team: zone.team };
  return placeKey(zonePlace) === placeKey(place);
}
async function planLinearToGitFromRepository(context) {
  const { input } = await readPlanSources(context);
  const treePaths = new Set((await listTree(context.git, context.fetched.tracked)).map((entry) => entry.path));
  return planLinearToGit({ ...input, treePaths });
}
async function confirmLinearToGit(context, options) {
  const { git, fetched } = context;
  const transforms = options.transforms ?? [];
  const identity = options.identity ?? SYNC_IDENTITY;
  const batch = Math.max(1, options.progressBatch ?? PROGRESS_BATCH);
  const stopAfter = "stopAfterDocuments" in options ? options.stopAfterDocuments : testStopAfterDocuments();
  const { input, documents } = await readPlanSources(context, { withContent: true });
  const treePaths = new Set((await listTree(git, fetched.tracked)).map((entry) => entry.path));
  const plan = planLinearToGit({ ...input, treePaths });
  const expected = { ...fetched.state };
  const resumed = await readInitialSyncProgress(git, expected.ids) !== null;
  const previous3 = await readIds(git, expected.ids);
  const ids = resumed ? new Map(previous3) : /* @__PURE__ */ new Map();
  const result = {
    complete: false,
    resumed,
    overwritten: [],
    created: [],
    skippedCompleted: [],
    removed: [],
    leftOutAtRecord: [],
    notAttempted: [],
    progressPushes: 0,
    record: null,
    pullRequest: null
  };
  let unpushed = 0;
  const pushProgress = async () => {
    if (options.stageOnly === true) {
      unpushed = 0;
      return true;
    }
    const next = await commitIds(git, expected.ids, ids, identity, { message: initialSyncProgressMessage(fetched.tracked), always: true });
    const pushed = await pushAtomic(git, options.config, [{ ref: stateRef(options.config, "ids"), expected: expected.ids, next }]);
    if (!pushed.ok) return false;
    expected.ids = next;
    result.progressPushes += 1;
    unpushed = 0;
    return true;
  };
  if (fetched.sync !== null && !await isOwnRecord(fetched.sync) && !await isAncestor(git, fetched.sync, fetched.tracked)) {
    result.code = "sync-branch-changed";
    return { plan, result };
  }
  const work = [...plan.overwrite.map((entry) => ({ kind: "overwrite", entry })), ...plan.create.map((entry) => ({ kind: "create", entry }))].sort(
    (a, b) => compare4(a.entry.path, b.entry.path)
  );
  const completed = (entry) => resumed && previous3.get(entry.path)?.id === entry.documentId;
  let taken = 0;
  for (let index2 = 0; index2 < work.length; index2 += 1) {
    const { kind, entry } = work[index2];
    if (completed(entry)) {
      result.skippedCompleted.push(entry.path);
      continue;
    }
    if (stopAfter !== void 0 && taken >= stopAfter) {
      result.stopped = { kind: "test-threshold", documents: stopAfter };
      result.notAttempted = work.slice(index2).filter((rest) => !completed(rest.entry)).map((rest) => rest.entry.path);
      break;
    }
    const before = previous3.get(entry.path);
    ids.set(entry.path, before !== void 0 && before.id === entry.documentId && before.saved !== void 0 ? { id: entry.documentId, saved: before.saved } : { id: entry.documentId });
    (kind === "overwrite" ? result.overwritten : result.created).push(entry.path);
    taken += 1;
    if (before?.id !== entry.documentId) unpushed += 1;
    if (unpushed >= batch && !await pushProgress()) return { plan, result: { ...result, code: "state-moved" } };
  }
  if (result.stopped !== void 0) {
    if (unpushed > 0 && !await pushProgress()) return { plan, result: { ...result, code: "state-moved" } };
    result.code = "stopped";
    return { plan, result };
  }
  const recorded = await record();
  if (recorded === "staged") return { plan, result };
  if (recorded === "sync-branch-changed") {
    result.code = "sync-branch-changed";
    return { plan, result };
  }
  if (recorded === null) {
    result.code = "state-moved";
    return { plan, result };
  }
  result.record = recorded;
  result.removed = [...plan.remove];
  try {
    if (recorded.needsPullRequest) {
      const { pullRequest, opened, updated } = await ensurePullRequest(options.github, {
        head: options.config.syncBranch,
        base: options.config.trackedBranch,
        title: PULL_REQUEST_TITLE,
        body: pullRequestBody(plan, result)
      });
      result.pullRequest = { ...pullRequest, opened, updated };
    } else if (recorded.closesPullRequest) {
      const open = await findOpenPullRequest(options.github, options.config.syncBranch, options.config.trackedBranch);
      if (open !== null) {
        await closePullRequest(options.github, open.number);
        result.closedPullRequest = open.number;
      }
    }
  } catch (error) {
    result.code = "pull-request-failed";
    if (error instanceof PullRequestError && error.status !== void 0) result.pullRequestStatus = error.status;
    return { plan, result };
  }
  result.complete = true;
  return { plan, result };
  async function record() {
    const bodies = /* @__PURE__ */ new Map();
    let linkBase;
    const documentOf = new Map([...plan.overwrite, ...plan.create].map((entry) => [entry.path, entry.documentId]));
    let linkMemo;
    const linkMap = (base) => {
      if (linkMemo?.entries !== entries || linkMemo.kept !== keptTracked.size) {
        const ids2 = new Map([...entries.map((entry) => [entry.path, entry.documentId]), ...[...keptTracked].map((path2) => [path2, documentOf.get(path2)])]);
        linkMemo = { entries, kept: keptTracked.size, map: { base, ids: ids2 } };
      }
      return linkMemo.map;
    };
    const restored = (entry) => {
      const { body: body2 } = bodies.get(entry.path);
      if (linkBase === void 0) return body2;
      const map = linkMap(linkBase);
      const seen = /* @__PURE__ */ new Map();
      const tracked = input.texts.get(entry.path);
      if (tracked !== void 0) linksToLinear(splitFile(tracked).body, entry.path, map, seen);
      return linksFromLinear(body2, entry.path, map, seen);
    };
    const textOf = (entry) => {
      const body2 = restored(entry);
      const tracked = input.texts.get(entry.path);
      if (tracked === void 0) return body2;
      const { head } = splitFile(tracked);
      const fenced = head.replace(/^﻿/, "") !== "";
      return fenced && body2 !== "" && !head.endsWith("\n") ? `${head}
${body2}` : head + body2;
    };
    const leaveOut = (paths, rule) => {
      const out = new Set(paths);
      if (out.size === 0) return;
      for (const path2 of out) {
        result.leftOutAtRecord.push({ path: path2, rule });
        ids.delete(path2);
      }
      entries = entries.filter((entry) => !out.has(entry.path));
      result.created = result.created.filter((path2) => !out.has(path2));
      result.overwritten = result.overwritten.filter((path2) => !out.has(path2));
      result.skippedCompleted = result.skippedCompleted.filter((path2) => !out.has(path2));
    };
    let entries = [...plan.overwrite, ...plan.create];
    const uploads = await readUploads(git, expected.uploads);
    const download2 = createAssetCapture(git, options.config, fetched.tracked, options.fetch ?? ((url, init) => context.linear.transport.fetchUpload(String(url), init)), context.linear.transport.reads);
    const failed2 = [];
    if (entries.some((entry) => linksLinearDocuments(documents.get(entry.documentId).content ?? ""))) {
      linkBase = documentUrlBase(await workspaceUrlKey(context.linear));
    }
    for (const entry of entries) {
      const content4 = documents.get(entry.documentId).content ?? "";
      const tracked = input.texts.get(entry.path);
      const trackedBody = tracked === void 0 ? void 0 : splitFile(tracked).body;
      try {
        const captured = await download2(entry.path, restoreBody(transforms, entry.path, content4, content4), uploads, trackedBody);
        bodies.set(entry.path, captured);
      } catch (error) {
        if (error instanceof LinearStoppedError) throw error;
        failed2.push(entry.path);
      }
    }
    const created = new Set(plan.create.map((entry) => entry.path));
    const keptTracked = /* @__PURE__ */ new Set();
    const keepTracked = (paths, rule) => {
      const kept2 = new Set(paths.filter((path2) => !created.has(path2)));
      for (const path2 of kept2) {
        result.leftOutAtRecord.push({ path: path2, rule });
        keptTracked.add(path2);
      }
      entries = entries.filter((entry) => !kept2.has(entry.path));
      result.overwritten = result.overwritten.filter((path2) => !kept2.has(path2));
      leaveOut(paths.filter((path2) => created.has(path2)), rule);
    };
    keepTracked(failed2, "download-failed");
    keepTracked(entries.filter((entry) => splitFile(textOf(entry)).body !== restored(entry)).map((entry) => entry.path), "front-matter-boundary");
    const gate = options.security ?? await securityGate(git, fetched.tracked);
    try {
      if (gate.configured) {
        const blocked = [];
        const unchecked = [];
        for (const entry of entries) {
          const { files } = bodies.get(entry.path);
          const text4 = textOf(entry);
          if (files.size === 0 && text4 === input.texts.get(entry.path)) continue;
          const findings = await gate.check(new Map([[entry.path, text4], ...files]));
          if (findings === null) unchecked.push(entry.path);
          else if (findings.length > 0) blocked.push(entry.path);
        }
        keepTracked(blocked, "security-hook");
        keepTracked(unchecked, "security-unchecked");
      }
    } finally {
      await gate.close?.();
    }
    context.linear.transport.reads?.end();
    if (options.stageOnly === true) return "staged";
    let lfsObjects = [];
    const stored = /* @__PURE__ */ new Map();
    const same = (a, b) => a === null || b === null ? a === b : Buffer.from(a).equals(Buffer.from(b));
    let commit = await build(entries);
    for (let attempt = 0; ; attempt += 1) {
      const misplaced = mismatches(await loadMapping(git, commit), entries);
      if (misplaced.length === 0) break;
      const newPaths = entries.filter((entry) => created.has(entry.path)).map((entry) => entry.path);
      if (attempt === 0) {
        const moved = misplaced.some((path2) => !created.has(path2));
        const newReadmes = moved ? newPaths.filter((path2) => /(^|\/)README\.md$/.test(path2)) : [];
        leaveOut([...misplaced.filter((path2) => created.has(path2)), ...newReadmes], "title-not-a-path");
      } else if (attempt === 1 && newPaths.length > 0) {
        leaveOut(newPaths, "title-not-a-path");
      } else {
        throw new Error(`the recorded tree maps ${misplaced.length} files to other documents`);
      }
      commit = await build(entries);
    }
    async function build(list2) {
      const changes = /* @__PURE__ */ new Map();
      for (const entry of list2) {
        for (const [path2, bytes] of bodies.get(entry.path).files) changes.set(path2, bytes);
        changes.set(entry.path, textOf(entry));
      }
      for (const path2 of plan.remove) changes.set(path2, null);
      const fresh = new Map([...changes].filter(([path2, content4]) => !same(stored.get(path2)?.input ?? null, content4) || !stored.has(path2)));
      if (fresh.size > 0) for (const [path2, output] of (await prepareLfs(git, fetched.tracked, fresh)).changes) stored.set(path2, { input: fresh.get(path2), output });
      const prepared = new Map([...changes.keys()].map((path2) => [path2, stored.get(path2).output]));
      lfsObjects = [
        ...new Set(
          [...changes.keys()].map((path2) => stored.get(path2)).filter(({ input: input2, output }) => output !== null && output !== input2).map(({ output }) => parseLfsPointer(Buffer.from(output))?.oid).filter((oid) => oid !== void 0)
        )
      ];
      return commitTree(git, { parents: [fetched.tracked], base: fetched.tracked, changes: prepared, message: REVERSE_RECORD_MESSAGE, identity, skipIfUnchanged: false });
    }
    const trees = (await git.text(["show", "-s", "--format=%T", commit, fetched.tracked])).split("\n");
    const changesTracked = trees[0] !== trees[1];
    for (const previousRecord of [expected.linear, fetched.sync]) {
      if (previousRecord !== null && await sameRecord(previousRecord, commit)) {
        commit = previousRecord;
        break;
      }
    }
    const syncOpen = fetched.sync !== null && fetched.sync !== commit && !await isAncestor(git, fetched.sync, fetched.tracked);
    if (syncOpen && !await isOwnRecord(fetched.sync)) return "sync-branch-changed";
    const moveSync = fetched.sync !== commit && changesTracked;
    const synced = /* @__PURE__ */ new Set([...entries.map((entry) => entry.path), ...keptTracked]);
    const finalIds = new Map([...ids].filter(([path2]) => synced.has(path2)));
    const through = captureCursor([...keptTracked].map((path2) => documentOf.get(path2)));
    const kept = plan.kept.map((entry) => entry.path);
    const trailers = [...through === null ? [] : [captureCursorTrailer(through)], ...kept.map(keptAnnotationTrailer)];
    const previousKept = await readKeptAnnotations(git, expected.ids);
    const markersMoved = through !== null && through !== await readCaptureCursor(git, expected.ids) || previousKept.size !== kept.length || kept.some((path2) => !previousKept.has(path2));
    const idsCommit = await commitIds(git, expected.ids, finalIds, identity, {
      message: trailers.length === 0 ? FINAL_IDS_MESSAGE : `${FINAL_IDS_MESSAGE}

${trailers.join("\n")}`,
      always: markersMoved || await readInitialSyncProgress(git, expected.ids) !== null
    });
    const finalUploads = new Map(uploads);
    for (const entry of entries) for (const [hash, url] of bodies.get(entry.path).uploads) finalUploads.set(hash, url);
    const uploadsCommit = await commitUploads(git, expected.uploads, finalUploads, identity);
    if (lfsObjects.length > 0) await git.run(["lfs", "push", "--object-id", options.config.remote, ...lfsObjects]);
    const updates = [
      { ref: stateRef(options.config, "ids"), expected: expected.ids, next: idsCommit },
      { ref: stateRef(options.config, "uploads"), expected: expected.uploads, next: uploadsCommit },
      // Initial sync replaces `linear`: its new record does not descend from an earlier one.
      { ref: stateRef(options.config, "linear"), expected: expected.linear, next: commit, replace: true }
    ];
    if (moveSync) updates.push({ ref: branchRef(options.config.syncBranch), expected: fetched.sync, next: commit, replace: true });
    const pushed = await pushAtomic(git, options.config, updates);
    if (!pushed.ok) return null;
    const parents = (await git.text(["show", "-s", "--format=%P", commit])).split(" ").filter(Boolean);
    return {
      linear: commit,
      moved: pushed.updated.length > 0,
      parents,
      hasTrackedParent: parents.length === 1 && parents[0] === fetched.tracked,
      changesTracked,
      needsPullRequest: changesTracked,
      closesPullRequest: !changesTracked && syncOpen
    };
  }
  function captureCursor(pendingIds) {
    const listed = new Map(input.places.flatMap(({ documents: placed }) => placed.map((document4) => [document4.id, cursorTime(document4)])));
    if (pendingIds.length > 0) return pendingIds.map((id) => listed.get(id)).reduce((a, b) => b < a ? b : a);
    return [...listed.values()].reduce((a, b) => a === null || b > a ? b : a, null);
  }
  async function sameRecord(a, b) {
    const describe2 = (oid) => git.text(["show", "-s", "--format=%T %P%n%s", oid]);
    return await describe2(a) === await describe2(b);
  }
  async function isOwnRecord(oid) {
    const [subject, email, parents] = (await git.text(["show", "-s", "--format=%s%n%ae%n%P", oid])).split("\n");
    return subject === REVERSE_RECORD_MESSAGE && email === identity.email && (parents ?? "").split(" ").filter(Boolean).length === 1;
  }
}
function mismatches(mapping, entries) {
  const mapped = new Map(mapping.documents.map((document4) => [document4.path, document4]));
  return entries.filter((entry) => {
    const file = mapped.get(entry.path);
    return file === void 0 || placeKey(file.place) !== placeKey(entry.place) || file.title.normalize("NFC") !== entry.fileTitle.normalize("NFC");
  }).map((entry) => entry.path).sort(compare4);
}
function pullRequestBody(plan, result) {
  const out = new Set(result.leftOutAtRecord.map((entry) => entry.path));
  const overwritten = plan.overwrite.filter((entry) => !out.has(entry.path)).length;
  const created = plan.create.filter((entry) => !out.has(entry.path)).length;
  const lines2 = [
    "This pull request makes the synchronized folders equal to Linear, as an initial sync from Linear asked.",
    "",
    `- ${count(overwritten, "file")} take Linear's text (front matter kept);`,
    `- ${count(created, "file")} are new, one per document only in Linear;`,
    `- ${count(plan.remove.length, "file")} are removed: they have no document in Linear.`,
    "",
    "Review it and merge it with a merge commit. The sync does not merge it, because it removes files, and it does not run until this pull request is merged. Removed files stay in the history."
  ];
  if (plan.remove.length > 0) {
    lines2.push("", "### Removed files", "");
    for (const path2 of plan.remove.slice(0, 100)) lines2.push(`- \`${path2.replace(/`/g, "'")}\``);
    if (plan.remove.length > 100) lines2.push(`- and ${plan.remove.length - 100} more`);
  }
  return `${lines2.join("\n")}
`;
}
function entryOf(entry) {
  return { path: entry.path, title: entry.title, place: entry.place, documentId: entry.documentId, fileTitle: entry.title };
}
function count(n, noun) {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}
function compare4(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

// src/initial-sync/summary.ts
var DIRECTIONS = ["git-to-linear", "linear-to-git"];
function toPlanReport(plan, direction, confirm) {
  const paths = (entries) => entries.map((entry) => entry.path);
  return {
    capacity: plan.capacity ?? [],
    direction,
    confirm,
    plan: {
      create: paths(plan.create),
      overwrite: paths(plan.overwrite),
      trash: paths(plan.trash),
      remove: [],
      paths: [.../* @__PURE__ */ new Set([...paths(plan.create), ...paths(plan.overwrite), ...paths(plan.trash)])].sort(compare5)
    },
    leftOut: paths(plan.leftOut),
    leftOutFiles: plan.leftOut,
    collisionPaths: plan.leftOut.filter((entry) => entry.rules.includes("duplicate-title")).map((entry) => entry.path)
  };
}
function renderDryRun(plan) {
  const lines2 = [
    "## Initial sync from git to Linear: dry run",
    "",
    "Nothing was written. Run again with `confirm` set to `true` to make Linear equal to the tracked branch:",
    "",
    `- create ${count2(plan.create.length, "document")};`,
    `- overwrite ${count2(plan.overwrite.length, "document")} with the file's text (same document, comments kept);`,
    `- move ${count2(plan.trash.length, "document")} without a file to Linear's trash, from which they can be restored;`,
    `- leave out ${count2(plan.leftOut.length, "file")}, which stay in git only until they are fixed.`,
    ""
  ];
  pushTable(lines2, "Create", ["Path", "In Linear"], plan.create.map((entry) => [entry.path, placeLabel(entry.place)]), true);
  pushTable(lines2, "Overwrite", ["Path", "In Linear", "Document"], plan.overwrite.map((entry) => [entry.path, placeLabel(entry.place), entry.documentId]), true);
  pushTable(lines2, "Move to trash", ["Path", "In Linear", "Document"], plan.trash.map((entry) => [entry.path, placeLabel(entry.place), entry.documentId]), true);
  pushTable(lines2, "Left out", LEFT_OUT_HEAD, leftOutRows(plan.leftOut), true);
  return lines2.join("\n") + renderCapacity(plan.capacity ?? []);
}
function renderConfirmed(plan, result) {
  const outcome2 = result.complete ? "Linear now equals the tracked branch, and the sync state is recorded." : result.code === "container-cap" ? "Nothing was written. Reduce planned additions or increase document-cap after checking the container limit." : result.code === "state-moved" ? "A state ref moved while this run was writing, so it recorded nothing more. Another run may be working on this repository; run initial sync again when it is done." : "The run stopped before it finished, so the sync state is not recorded yet. Run initial sync again with the same inputs to go on; documents already written are skipped.";
  const lines2 = [
    "## Initial sync from git to Linear",
    "",
    outcome2,
    "",
    `- created ${count2(result.created.length, "document")};`,
    `- overwrote ${count2(result.overwritten.length, "document")} with the file's text (same document, comments kept);`,
    `- left ${count2(result.unchanged.length, "document")} as they were: they already held the file's text;`,
    ...result.resumed ? [`- skipped ${count2(result.skippedCompleted.length, "document")} written by the run this one continued;`] : [],
    `- moved ${count2(result.trashed.length, "document")} without a file to Linear's trash, from which they can be restored;`,
    `- left out ${count2(plan.leftOut.length + result.leftOutAtWrite.length, "file")}, which stay in git only until they are fixed.`,
    ""
  ];
  if (result.stopped !== void 0) {
    const why = result.stopped.kind === "test-threshold" ? `the test threshold of ${result.stopped.documents} documents` : describeStop(result.stopped);
    lines2.push(`Stopped: ${why}. Not written yet: ${count2(result.notAttempted.length, "item")}.`, "");
  }
  pushTable(lines2, "Failed", ["Path", "Operation", "Error"], result.failed.map((entry) => [entry.path, entry.operation, entry.error]), false);
  pushTable(lines2, "Moved to trash", ["Path"], result.trashed.map((path2) => [path2]), false);
  pushTable(
    lines2,
    "Left out",
    ["Path", "Rules", "Lines", "Collides with, or the files"],
    [...leftOutRows(plan.leftOut), ...result.leftOutAtWrite.map((entry) => [entry.path, entry.rule, "", (entry.files ?? []).join(", ")])],
    false
  );
  if (result.record !== null && result.record.reformatted.length > 0) {
    lines2.push(
      `Linear stores ${count2(result.record.reformatted.length, "file")} in a different form than the tracked branch; the next sync proposes that form in its pull request.`,
      ""
    );
  }
  return lines2.join("\n") + renderCapacity(plan.capacity ?? []);
}
function toReversePlanReport(plan, confirm) {
  const paths = (entries) => entries.map((entry) => entry.path);
  return {
    direction: "linear-to-git",
    confirm,
    plan: {
      create: paths(plan.create),
      overwrite: paths(plan.overwrite),
      trash: [],
      remove: [...plan.remove],
      paths: [.../* @__PURE__ */ new Set([...paths(plan.create), ...paths(plan.overwrite), ...plan.remove])].sort(compare5)
    },
    leftOut: paths(plan.leftOut),
    leftOutFiles: plan.leftOut,
    collisionPaths: plan.leftOut.filter((entry) => entry.rules.includes("duplicate-title")).map((entry) => entry.path),
    // Nothing is created in Linear, so no container comes closer to its document cap.
    capacity: []
  };
}
function renderReverseDryRun(plan) {
  const lines2 = [
    "## Initial sync from Linear to the tracked branch: dry run",
    "",
    "Nothing was written. Run again with `confirm` set to `true` to open one pull request that makes the synchronized folders equal to Linear. A person merges it; the sync never does, because it removes files:",
    "",
    `- overwrite ${count2(plan.overwrite.length, "file")} with the document's text (front matter kept);`,
    `- create ${count2(plan.create.length, "file")}, one per document without a file;`,
    `- remove ${count2(plan.remove.length, "file")} without a document (they stay in the history);`,
    `- keep ${count2(plan.kept.length, "file")} without a document that hold a folder's annotation;`,
    `- leave out ${count2(plan.leftOut.length, "file or document", "files or documents")}.`,
    ""
  ];
  pushTable(lines2, "Overwrite", ["Path", "Document"], plan.overwrite.map((entry) => [entry.path, entry.documentId]), true);
  pushTable(lines2, "Create", ["Path", "From Linear", "Document"], plan.create.map((entry) => [entry.path, placeLabel(entry.place), entry.documentId]), true);
  pushTable(lines2, "Remove", ["Path"], plan.remove.map((path2) => [path2]), true);
  pushTable(lines2, "Kept", ["Path", "Why"], plan.kept.map((entry) => [entry.path, "holds the annotation of its folder"]), false);
  pushTable(lines2, "Left out", LEFT_OUT_HEAD, leftOutRows(plan.leftOut), true);
  return lines2.join("\n");
}
function renderReverseConfirmed(plan, result) {
  const outcome2 = result.complete ? result.pullRequest === null ? `The tracked branch already equals Linear: no pull request is needed. The sync state is recorded.${result.closedPullRequest === void 0 ? "" : ` Pull request #${result.closedPullRequest} of an earlier run had nothing left to carry and is closed.`}` : `The sync state is recorded and pull request #${result.pullRequest.number} ${result.pullRequest.opened ? "is open" : "was already open"}. A person reviews and merges it; the sync does not run until it is merged.` : result.code === "state-moved" ? "A state ref moved while this run was working, so it recorded nothing more. Another run may be working on this repository; run initial sync again when it is done." : result.code === "pull-request-failed" ? `The sync state is recorded, but the pull request could not be opened (${result.pullRequestStatus === void 0 ? "GitHub could not be reached" : `GitHub answered HTTP ${result.pullRequestStatus}`}). Run initial sync again with the same inputs to open it.` : result.code === "sync-branch-changed" ? "The sync branch holds commits this sync did not make, so nothing was recorded. Merge or close its pull request and delete the branch, then run initial sync again." : "The run stopped before it finished, so the sync state is not recorded yet. Run initial sync again with the same inputs to go on; documents already taken are skipped.";
  const lines2 = [
    "## Initial sync from Linear to the tracked branch",
    "",
    outcome2,
    "",
    `- took ${count2(result.overwritten.length, "document")} into existing files and ${count2(result.created.length, "document")} into new files;`,
    ...result.resumed ? [`- skipped ${count2(result.skippedCompleted.length, "document")} taken by the run this one continued;`] : [],
    `- ${result.record === null ? "will remove" : "removes"} ${count2(plan.remove.length, "file")} without a document;`,
    `- left out ${count2(plan.leftOut.length + result.leftOutAtRecord.length, "file or document", "files or documents")}.`,
    ""
  ];
  if (result.stopped !== void 0) {
    const why = result.stopped.kind === "test-threshold" ? `the test threshold of ${result.stopped.documents} documents` : describeStop(result.stopped);
    lines2.push(`Stopped: ${why}. Not taken yet: ${count2(result.notAttempted.length, "document")}.`, "");
  }
  pushTable(lines2, "Remove", ["Path"], plan.remove.map((path2) => [path2]), false);
  pushTable(lines2, "Left out", LEFT_OUT_HEAD, [...leftOutRows(plan.leftOut), ...result.leftOutAtRecord.map((entry) => [entry.path, entry.rule, "", ""])], false);
  return lines2.join("\n");
}
var LEFT_OUT_HEAD = ["Path", "Rules", "Lines", "Collides with, or the files"];
function leftOutRows(entries) {
  return entries.map((entry) => [entry.path, entry.rules.join(", "), entry.lines.join(", "), (entry.collidesWith ?? entry.files ?? []).join(", ")]);
}
function pushTable(lines2, title, head, rows, always) {
  if (rows.length === 0 && !always) return;
  lines2.push(`### ${title} (${rows.length})`, "");
  if (rows.length === 0) {
    lines2.push("None.", "");
    return;
  }
  lines2.push(`| ${head.join(" | ")} |`, `| ${head.map(() => "---").join(" | ")} |`);
  for (const row of rows) lines2.push(`| ${row.map(cell).join(" | ")} |`);
  lines2.push("");
}
function count2(n, noun, plural = `${noun}s`) {
  return `${n} ${n === 1 ? noun : plural}`;
}
function compare5(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

// src/run/inputs.ts
var InputError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "InputError";
  }
};
function environmentName(name) {
  return `MDBISYNC_${name.toUpperCase().replace(/-/g, "_")}`;
}
function readInputs(get, env = process.env) {
  const value = (name) => get(name).trim();
  const required = (name) => {
    const given = value(name);
    if (given === "") throw new InputError(`the input ${name} is required`);
    return given;
  };
  const linear = { clientId: required("linear-client-id"), clientSecret: required("linear-client-secret") };
  const token = required("github-token");
  const repository = value("repository") || (env.GITHUB_REPOSITORY ?? "").trim();
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    throw new InputError(`the input repository must be "owner/name" (it defaults to the workflow's repository)`);
  }
  const inputs = {
    linear,
    github: { token, repository },
    state: stateConfig(value("tracked-branch"), value("sync-branch"), value("state-ref-prefix"))
  };
  const linearApiUrl = value("linear-api-url");
  if (linearApiUrl !== "") inputs.linear.apiUrl = linearApiUrl;
  const githubApiUrl = value("github-api-url") || (env.GITHUB_API_URL ?? "").trim();
  if (githubApiUrl !== "") inputs.github.apiUrl = githubApiUrl;
  const reportFile = value("report-file");
  if (reportFile !== "") inputs.reportFile = reportFile;
  const cap = value("document-cap");
  if (cap !== "") {
    if (!/^[1-9][0-9]*$/.test(cap) || !Number.isSafeInteger(Number(cap))) throw new InputError("the input document-cap must be a positive safe integer");
    inputs.documentCap = Number(cap);
  }
  const grace = value("merge-grace-seconds");
  if (grace !== "") {
    if (!/^(0|[1-9][0-9]*)$/.test(grace) || Number(grace) > 120) throw new InputError("the input merge-grace-seconds must be an integer from 0 to 120");
    inputs.mergeGraceSeconds = Number(grace);
  }
  return inputs;
}
function stateConfig(trackedBranch, syncBranch, refPrefix) {
  try {
    return resolveStateConfig({ trackedBranch, syncBranch, refPrefix });
  } catch (error) {
    if (error instanceof StateConfigError) throw new InputError(error.message);
    throw error;
  }
}
function readInitialSyncInputs(get) {
  const direction = get("direction").trim();
  if (!DIRECTIONS.includes(direction)) {
    const given = direction === "" ? "is required" : `must be one of ${DIRECTIONS.join(", ")}, not "${direction}"`;
    throw new InputError(`the input direction ${given} (initial sync never picks a direction itself)`);
  }
  return { direction, confirm: get("confirm").trim() === "true" };
}

// src/run/preflight.ts
async function runPreflight(operation, inputs, options, work) {
  const { git } = options;
  const fetched = await fetchState(git, inputs.state);
  if (operation === "sync") {
    const unfinished = await readInitialSyncProgress(git, fetched.state.ids) !== null;
    const pending = await initialPullRequestPending(git, { linear: fetched.state.linear, tracked: fetched.tracked });
    const refusal = checkSyncState(fetched.state, inputs.state, unfinished, pending);
    if (refusal !== null) return { operation, ok: false, code: refusal.code, summary: renderStateRefusal(refusal), refusal };
  } else if (options.refusePendingInitialPullRequest === true) {
    const pending = fetched.sync !== null && fetched.state.linear !== null && await isAncestor(git, fetched.state.linear, fetched.sync) && await initialPullRequestPending(git, { linear: fetched.state.linear, tracked: fetched.tracked });
    const refusal = checkSyncState(fetched.state, inputs.state, false, pending);
    if (refusal?.code === "initial-pull-request-pending") return { operation, ok: false, code: refusal.code, summary: renderStateRefusal(refusal), refusal };
  }
  const mapping = await loadMapping(git, fetched.tracked);
  const hooks = readHookConfig(await readTrackedFile(git, fetched.tracked, PRE_COMMIT_CONFIG));
  const github = await checkGitHub({ ...inputs.github, commit: fetched.tracked, ...options.fetch ? { fetch: options.fetch } : {} });
  const stats = new RequestStats();
  const requestHooks = { log: options.log };
  const tokenOptions = { hooks: requestHooks, baseUrl: inputs.linear.apiUrl, stats, ...options.fetch ? { fetch: options.fetch } : {} };
  const credentials = { clientId: inputs.linear.clientId, clientSecret: inputs.linear.clientSecret };
  const onRevokeError = (error) => options.warn(`the run's Linear token could not be revoked: ${error instanceof Error ? error.message : String(error)}`);
  let minted = false;
  const reads = options.reads;
  const runOptions = { ...tokenOptions, onRevokeError, ...options.tokenLifecycle ? { lifecycle: options.tokenLifecycle } : {} };
  const withToken = (work2) => {
    const known = reads?.token;
    if (known != null) return withDeferredRunToken(credentials, known, runOptions, (token) => work2({ ...token, accessToken: () => token.accessToken() }));
    return withRunToken(credentials, runOptions, (token) => {
      reads?.tokenMinted(token.scope, token.context);
      return work2(token);
    });
  };
  try {
    return await withToken(async (token) => {
      minted = true;
      const linear = new LinearClient({ ...tokenOptions, token: token.accessToken, auth: token.context, ...reads ? { reads } : {} });
      let setup;
      try {
        const { report, targets } = await runSetupCheck({ mapping, hooks, github, linear: { client: linear, scope: token.scope } });
        setup = report;
        if (report.ok && targets !== void 0 && work !== void 0) await work({ git, fetched, mapping, targets, linear });
        return { ...outcome(operation, report), writesAfterStop: stats.writesAfterStop, linearWrites: stats.writes };
      } catch (error) {
        if (!(error instanceof LinearStoppedError)) throw error;
        return { ...stoppedOutcome(operation, error.reason, setup), writesAfterStop: stats.writesAfterStop, linearWrites: stats.writes };
      }
    });
  } catch (error) {
    if (minted || !isCredentialError(error)) throw error;
    const { report } = await runSetupCheck({ mapping, hooks, github, linear: { error: "Linear refused the OAuth app client credentials" } });
    return outcome(operation, report);
  }
}
function stoppedOutcome(operation, stopped, setup) {
  const summary2 = renderStoppedBeforeWriting(stopped, operation === "sync");
  return {
    operation,
    ok: false,
    stopped,
    summary: setup === void 0 ? summary2 : `${renderSetupSummary(setup).trimEnd()}

${summary2}`,
    ...setup === void 0 ? {} : { setup }
  };
}
function outcome(operation, report) {
  const result = { operation, ok: report.ok, summary: renderSetupSummary(report), setup: report };
  if (report.code !== void 0) result.code = report.code;
  return result;
}
async function readTrackedFile(git, commit, path2) {
  const result = await git.run(["cat-file", "blob", `${commit}:${path2}`], { okCodes: [0, 128] });
  return result.code === 0 ? result.stdout.toString("utf8") : null;
}

// src/run/capacity.ts
var DEFAULT_DOCUMENT_CAP = 1e3;
function containerKey(context, place) {
  return documentPlaceKey(placeId(context.targets, place));
}
function documentPlaceKey(place) {
  return JSON.stringify("projectId" in place ? { projectId: place.projectId } : { teamId: place.teamId });
}
async function readContainerDocuments(context) {
  const places = [...new Map(annotatedPlaces(context.mapping.zones).map(({ place }) => [containerKey(context, place), placeId(context.targets, place)])).values()];
  return containersOf(context, await context.linear.listDocumentsInPlaces(places, { includeArchived: true }));
}
function containersOf(context, listed) {
  const documents = /* @__PURE__ */ new Map();
  for (const { place } of annotatedPlaces(context.mapping.zones)) documents.set(containerKey(context, place), []);
  for (const document4 of listed) {
    const place = document4.projectId !== null ? { projectId: document4.projectId } : document4.teamId !== null ? { teamId: document4.teamId } : void 0;
    if (place !== void 0) documents.get(documentPlaceKey(place))?.push(document4);
  }
  return documents;
}
function assessCapacity(context, documents, creates, cap = DEFAULT_DOCUMENT_CAP) {
  const planned = /* @__PURE__ */ new Map();
  for (const { place } of creates) {
    const key = containerKey(context, place);
    planned.set(key, (planned.get(key) ?? 0) + 1);
  }
  const result = /* @__PURE__ */ new Map();
  for (const { place } of annotatedPlaces(context.mapping.zones)) {
    const key = containerKey(context, place);
    if (result.has(key)) continue;
    const listed = documents.get(key);
    if (listed === void 0) throw new Error("container documents were not read");
    const unique = [...new Map(listed.map((document4) => [document4.id, document4])).values()];
    const trashed = unique.filter((document4) => document4.trashed).length;
    const archived = unique.filter((document4) => !document4.trashed && document4.archivedAt !== null).length;
    const count4 = planned.get(key) ?? 0;
    const total = unique.length + count4;
    result.set(key, {
      place,
      live: unique.length - trashed - archived,
      trashed,
      archived,
      planned: count4,
      total,
      cap,
      status: total > cap ? "over-cap" : total >= cap * 0.9 ? "warning" : "ok"
    });
  }
  return [...result.values()];
}
function capacityBlocked(capacity) {
  return capacity.some((container) => container.status === "over-cap");
}
function renderCapacity(capacity) {
  const reported = capacity.filter((container) => container.status !== "ok");
  if (reported.length === 0) return "";
  return [
    "### Container document capacity",
    "",
    capacityBlocked(capacity) ? "Stopped before any write: a container would exceed its document cap." : "Warning: a container is within 10% of its document cap. The run may proceed.",
    "",
    "Counts include trashed and archived documents returned by Linear with `includeArchived: true`. Moving a document to trash does not free capacity.",
    "",
    "| Container | Live | Trashed | Archived | Planned additions | Total | Cap | Status |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
    ...reported.map((c) => `| ${cell(placeLabel(c.place))} | ${c.live} | ${c.trashed} | ${c.archived} | ${c.planned} | ${c.total} | ${c.cap} | ${c.status} |`),
    ""
  ].join("\n");
}

// src/initial-sync/plan.ts
function annotatedPlaces(zones) {
  const places = /* @__PURE__ */ new Map();
  for (const zone of [...zones.values()].sort((a, b) => compare6(zoneFolder(a), zoneFolder(b)))) {
    const place = zone.project !== void 0 ? { kind: "project", team: zone.team, project: zone.project } : { kind: "team", team: zone.team };
    const key = placeKey(place);
    if (!places.has(key)) places.set(key, { place, folder: zoneFolder(zone) });
  }
  return [...places.values()];
}
function placeId(targets, place) {
  if (place.kind === "project") {
    const project = targets.projects.get(projectKey(place.team, place.project));
    if (project === void 0) throw new Error(`project "${place.project}" of team "${place.team}" was not resolved`);
    return { projectId: project.id };
  }
  const team = targets.teams.get(place.team);
  if (team === void 0) throw new Error(`team "${place.team}" was not resolved`);
  return { teamId: team.id };
}
function placeKey(place) {
  return place.kind === "project" ? `project\0${place.team}\0${place.project}` : `team\0${place.team}`;
}
function planInitialSync(input) {
  const facts = input.facts ?? LINEAR_FACTS;
  const { mapping } = input;
  const leftOut = /* @__PURE__ */ new Map();
  const leaveOut = (path2, rules, lines2 = [], collidesWith) => {
    const entry = leftOut.get(path2) ?? { path: path2, rules: [], lines: [] };
    entry.rules = [.../* @__PURE__ */ new Set([...entry.rules, ...rules])].sort();
    entry.lines = [.../* @__PURE__ */ new Set([...entry.lines, ...lines2])].sort((a, b) => a - b);
    if (collidesWith !== void 0) entry.collidesWith = [...collidesWith].sort(compare6);
    leftOut.set(path2, entry);
  };
  const textOf = (path2) => {
    const text4 = input.texts.get(path2);
    if (text4 === void 0) throw new Error(`the text of ${path2} was not read`);
    return text4;
  };
  const lint = (path2, title) => {
    const findings = lintText(path2, textOf(path2));
    if (findings.length > 0) leaveOut(path2, findings.map((f) => f.rule), findings.map((f) => f.line));
    if (lengthRefusal({ title }, facts) !== void 0) leaveOut(path2, ["title-too-long"]);
  };
  const leftOutTitles = /* @__PURE__ */ new Map();
  for (const file of mapping.leftOut) {
    leaveOut(file.path, [file.rule], [], file.collidesWith);
    lint(file.path, file.title);
    leftOutTitles.set(titleIn(file.place, file.title), file.path);
  }
  for (const file of mapping.unsynced) {
    if (file.place === void 0 || file.title === void 0) continue;
    leaveOut(file.path, [file.reason]);
    leftOutTitles.set(titleIn(file.place, file.title), file.path);
  }
  const synced = [];
  for (const document4 of mapping.documents) {
    lint(document4.path, document4.title);
    if (leftOut.has(document4.path)) leftOutTitles.set(titleIn(document4.place, document4.title), document4.path);
    else synced.push(document4);
  }
  const plan = { create: [], overwrite: [], trash: [], leftOut: [] };
  const filesByTitle = new Map(synced.map((document4) => [titleIn(document4.place, document4.title), document4]));
  const matched = /* @__PURE__ */ new Set();
  const folders = new Map(annotatedPlaces(mapping.zones).map(({ place, folder }) => [placeKey(place), folder]));
  for (const { place, documents } of input.places) {
    const oldestFirst = [...documents].sort((a, b) => compare6(a.createdAt, b.createdAt) || compare6(a.id, b.id));
    for (const document4 of oldestFirst) {
      if (document4.trashed || document4.archivedAt !== null) continue;
      const key = titleIn(place, document4.title);
      const file = filesByTitle.get(key);
      if (file !== void 0 && !matched.has(key)) {
        matched.add(key);
        plan.overwrite.push({ path: file.path, title: file.title, place, documentId: document4.id });
        continue;
      }
      const leftOutPath = leftOutTitles.get(key);
      if (leftOutPath !== void 0) {
        const entry = leftOut.get(leftOutPath);
        if (entry.documentId === void 0) {
          entry.documentId = document4.id;
          continue;
        }
      }
      const folder = folders.get(placeKey(place)) ?? "";
      plan.trash.push({ path: `${folder === "" ? "" : `${folder}/`}${document4.title}.md`, title: document4.title, place, documentId: document4.id });
    }
  }
  for (const document4 of synced) {
    if (!matched.has(titleIn(document4.place, document4.title))) plan.create.push({ path: document4.path, title: document4.title, place: document4.place });
  }
  const byPath = (entries) => entries.sort((a, b) => compare6(a.path, b.path));
  plan.create = byPath(plan.create);
  plan.overwrite = byPath(plan.overwrite);
  plan.trash = byPath(plan.trash);
  plan.leftOut = byPath([...leftOut.values()]);
  return plan;
}
function leaveOutAtWrite(plan, entries) {
  if (entries.length === 0) return plan;
  const byPath = new Map(entries.map((entry) => [entry.path, entry]));
  const leftOut = [...plan.leftOut];
  const add = (path2, documentId) => {
    const found = byPath.get(path2);
    if (found === void 0) return;
    leftOut.push({ path: path2, rules: [found.rule], lines: [], files: [...found.files], ...documentId !== void 0 ? { documentId } : {} });
  };
  for (const entry of plan.create) add(entry.path);
  for (const entry of plan.overwrite) add(entry.path, entry.documentId);
  return {
    ...plan,
    create: plan.create.filter((entry) => !byPath.has(entry.path)),
    overwrite: plan.overwrite.filter((entry) => !byPath.has(entry.path)),
    leftOut: leftOut.sort((a, b) => compare6(a.path, b.path))
  };
}
function titleIn(place, title) {
  return `${placeKey(place)}\0${title.normalize("NFC")}`;
}
function zoneFolder(zone) {
  return zone.projectFolder ?? zone.teamFolder;
}
function compare6(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

// src/run/stop.ts
var PARTIAL = "partial, will continue";
function renderStop(stop) {
  const why = stop.kind === "test-threshold" ? `the test threshold of ${stop.documents} documents` : describeStop(stop);
  const lines2 = [`Stopped: ${why}.`, ""];
  const limits = stop.kind === "test-threshold" ? void 0 : stop.limits;
  if (limits !== void 0) {
    lines2.push("Linear's rate-limit headers at the stop:", "", "| Header | Value |", "| --- | --- |");
    for (const name of Object.keys(limits).sort()) lines2.push(`| ${cell(name)} | ${cell(limits[name] ?? "")} |`);
    lines2.push("");
  }
  return lines2;
}
function renderStoppedBeforeWriting(stop, partial) {
  const outcome2 = partial ? `Stopped before any write; ${PARTIAL}: the next run starts again.` : "Stopped before any write: run it again once the limit has reset.";
  return ["## Linear stopped the run", "", outcome2, "", ...renderStop(stop)].join("\n");
}

// src/sync/marks.ts
import { createHash as createHash7, randomUUID as randomUUID2 } from "node:crypto";

// src/merge/merge.ts
import { mkdtemp as mkdtemp3, writeFile as writeFile3, rm as rm3 } from "node:fs/promises";
import { tmpdir as tmpdir3 } from "node:os";
import { join as join6 } from "node:path";

// src/merge/markers.ts
var MARKERS = {
  git: "**Sync conflict: git version**",
  linear: "**Sync conflict: Linear version**",
  end: "**Sync conflict: end**"
};
function lines(text4) {
  return text4.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}
function lineText(text4) {
  return text4.replace(/\r?\n$/, "");
}
function markerLines(text4) {
  const { head, body: body2 } = splitFile(text4);
  const offset = lineCount(head);
  const excluded = [];
  visit(parse2(body2), (node2) => {
    if (["code", "inlineCode", "blockquote", "html"].includes(node2.type) && node2.position) {
      excluded.push([node2.position.start.line + offset, node2.position.end.line + offset]);
    }
  });
  const values = Object.values(MARKERS);
  const found = /* @__PURE__ */ new Map();
  lines(body2).forEach((text5, i) => {
    const number = i + 1 + offset;
    const value = lineText(text5);
    if (values.includes(value) && !excluded.some(([a, b]) => number >= a && number <= b)) {
      found.set(number, value);
    }
  });
  return found;
}
function arm(source, start2, end2) {
  const content4 = source.slice(start2, end2);
  if (content4[0] !== void 0 && lineText(content4[0]) === "") content4.shift();
  if (content4.at(-1) !== void 0 && lineText(content4.at(-1)) === "") content4.pop();
  return content4.join("").replace(/\r?\n$/, "");
}
function detectConflicts(text4) {
  const source = lines(text4);
  const found = [];
  let start2;
  let middle;
  for (const [number, value] of markerLines(text4)) {
    if (value === MARKERS.git) {
      if (start2 !== void 0) found.push({ startLine: start2, endLine: number - 1 });
      start2 = number;
      middle = void 0;
    } else if (value === MARKERS.linear && start2 !== void 0 && middle === void 0) {
      middle = number;
    } else if (value === MARKERS.end && start2 !== void 0) {
      found.push(middle === void 0 ? { startLine: start2, endLine: number } : { startLine: start2, endLine: number, git: arm(source, start2, middle - 1), linear: arm(source, middle, number - 1) });
      start2 = void 0;
      middle = void 0;
    } else if (start2 === void 0) {
      found.push({ startLine: number, endLine: number });
    }
  }
  if (start2 !== void 0) found.push({ startLine: start2, endLine: source.length });
  return found.sort((a, b) => a.startLine - b.startLine);
}

// src/merge/merge.ts
function tokenize(text4, size) {
  const source = lines(text4);
  const tokens = [];
  for (let i = 0; i < source.length; i++) {
    const text5 = source[i];
    if (lineText(text5) !== `${"<".repeat(size)} git`) {
      tokens.push({ kind: "line", text: text5 });
      continue;
    }
    const ours = [];
    const theirs = [];
    while (++i < source.length && lineText(source[i]) !== "=".repeat(size)) ours.push(source[i]);
    while (++i < source.length && lineText(source[i]) !== `${">".repeat(size)} linear`) theirs.push(source[i]);
    if (i === source.length) throw new Error("Invalid merge-file conflict output");
    tokens.push({ kind: "conflict", ours, theirs });
  }
  return tokens;
}
function content3(token, side) {
  return token.kind === "line" ? [token.text] : token[side];
}
function nestedList(node2) {
  return "children" in node2 && node2.children.some((child) => child.type === "list" || nestedList(child));
}
function blockRanges(tokens, side) {
  const source = [];
  const tokenAtLine = [];
  tokens.forEach((token, i) => {
    for (const line2 of content3(token, side)) {
      source.push(line2);
      tokenAtLine.push(i);
    }
  });
  const text4 = source.join("");
  const ranges = [];
  const add = (startLine, endLine) => {
    const start2 = tokenAtLine[startLine - 1];
    const end2 = tokenAtLine[Math.min(endLine, source.length) - 1];
    if (start2 !== void 0 && end2 !== void 0) ranges.push({ start: start2, end: end2 + 1 });
  };
  visit(parse2(text4), (node2) => {
    if ((["code", "table", "blockquote", "inlineCode", "html", "heading"].includes(node2.type) || node2.type === "list" && (node2.ordered || nestedList(node2))) && node2.position) {
      add(node2.position.start.line, node2.position.end.line);
    }
  });
  for (const conflict of detectConflicts(text4)) add(conflict.startLine, conflict.endLine);
  return ranges;
}
function conflictRanges(tokens) {
  const blocks = [...blockRanges(tokens, "ours"), ...blockRanges(tokens, "theirs")];
  const ranges = tokens.flatMap((token, i) => token.kind === "conflict" ? [{ start: i, end: i + 1 }] : []);
  let changed2;
  do {
    changed2 = false;
    for (const range of ranges) {
      for (const block of blocks) {
        if (block.start < range.end && block.end > range.start) {
          const start2 = Math.min(range.start, block.start);
          const end2 = Math.max(range.end, block.end);
          if (start2 !== range.start || end2 !== range.end) changed2 = true;
          range.start = start2;
          range.end = end2;
        }
      }
    }
  } while (changed2);
  const merged = [];
  for (const range of ranges.sort((a, b) => a.start - b.start)) {
    const last = merged.at(-1);
    if (last && range.start < last.end) last.end = Math.max(last.end, range.end);
    else merged.push({ ...range });
  }
  return merged;
}
function withoutMarkers(tokens, side) {
  const projection = tokens.flatMap((token) => content3(token, side)).join("");
  const markers = markerLines(projection);
  let line2 = 0;
  return tokens.map((token) => content3(token, side).filter((text4) => {
    line2++;
    return !markers.has(line2) && !(markers.has(line2 - 1) && lineText(text4) === "");
  }));
}
function completeBlocks(text4) {
  const insertions = [];
  visit(parse2(text4), (node2) => {
    if (node2.type !== "code" && node2.type !== "html" || !node2.position) return;
    const { start: start2, end: end2 } = node2.position;
    const raw = text4.slice(start2.offset, end2.offset);
    let close;
    if (node2.type === "code") {
      const opener = /^(?: {0,3})(`{3,}|~{3,})/.exec(raw)?.[1];
      if (!opener) return;
      const source = lines(raw);
      const last = lineText(source.at(-1) ?? "");
      const fence = /^[ >\t]*(`{3,}|~{3,})[ \t]*$/.exec(last)?.[1];
      const closing = fence !== void 0 && fence[0] === opener[0] && fence.length >= opener.length;
      const valueLines = node2.value === "" ? 0 : node2.value.split("\n").length;
      if (source.length > valueLines + 1 && closing) return;
      close = opener;
    } else {
      const tag = /^<(script|pre|style|textarea)(?:\s|>)/i.exec(raw)?.[1];
      const terminator = raw.startsWith("<!--") ? "-->" : raw.startsWith("<?") ? "?>" : raw.startsWith("<![CDATA[") ? "]]>" : /^<![A-Z]/.test(raw) ? ">" : tag ? `</${tag}>` : void 0;
      if (!terminator || closedHtmlBlock(node2.value)) return;
      close = terminator;
    }
    const lineStart = text4.lastIndexOf("\n", start2.offset - 1) + 1;
    const prefix = text4.slice(lineStart, start2.offset).replace(/[^ >\t]/g, " ");
    insertions.push({ offset: end2.offset, text: `${raw.endsWith("\n") ? "" : "\n"}${prefix}${close}
` });
  });
  let completed = text4;
  for (const insertion of insertions.sort((a, b) => b.offset - a.offset)) {
    completed = completed.slice(0, insertion.offset) + insertion.text + completed.slice(insertion.offset);
  }
  return completed.replace(/\n$/, "");
}
function closedHtmlBlock(value) {
  return parse2(`${value}
x`).children.length > 1;
}
function render(tokens, ranges) {
  let text4 = "";
  let cursor = 0;
  const armsWithoutMarkers = { ours: withoutMarkers(tokens, "ours"), theirs: withoutMarkers(tokens, "theirs") };
  for (const range of ranges) {
    text4 += tokens.slice(cursor, range.start).map((token) => content3(token, "ours").join("")).join("");
    if (text4 && !text4.endsWith("\n\n")) text4 += text4.endsWith("\n") ? "\n" : "\n\n";
    const arms = (side) => completeBlocks(armsWithoutMarkers[side].slice(range.start, range.end).flat().join("").replace(/^\n|\n$/g, ""));
    text4 += `${MARKERS.git}

${arms("ours")}

${MARKERS.linear}

${arms("theirs")}

${MARKERS.end}
`;
    cursor = range.end;
    const next = tokens[cursor];
    if (next?.kind === "line" && lineText(next.text) !== "") text4 += "\n";
  }
  return text4 + tokens.slice(cursor).map((token) => content3(token, "ours").join("")).join("");
}
async function mergeHeads(dir, withBom) {
  const bom = withBom.ours.startsWith("\uFEFF") ? "\uFEFF" : "";
  const heads = Object.fromEntries(Object.entries(withBom).map(([name, text4]) => [name, text4.replace(/^﻿/, "")]));
  if (heads.theirs === heads.base || heads.ours === heads.theirs) return bom + heads.ours;
  if (heads.ours === heads.base) return bom + heads.theirs;
  await Promise.all(Object.entries(heads).map(([name, text4]) => writeFile3(join6(dir, `head-${name}`), text4, { mode: 384 })));
  const merged = await new Git(dir).run(["merge-file", "--stdout", "head-ours", "head-base", "head-theirs"], { okCodes: Array.from({ length: 128 }, (_, i) => i) });
  return bom + (merged.code === 0 ? merged.stdout.toString("utf8") : heads.ours);
}
async function mergeMarkdown(base, ours, theirs) {
  const gitFile = splitFile(ours);
  const heads = { base: splitFile(base).head, ours: gitFile.head, theirs: splitFile(theirs).head };
  const eol = ours.includes("\r\n") ? "\r\n" : "\n";
  base = splitFile(base).body.replaceAll("\r\n", "\n");
  ours = gitFile.body.replaceAll("\r\n", "\n");
  theirs = splitFile(theirs).body.replaceAll("\r\n", "\n");
  const dir = await mkdtemp3(join6(tmpdir3(), "markdown-merge-"));
  try {
    const head = await mergeHeads(dir, heads);
    await Promise.all([["base", base], ["ours", ours], ["theirs", theirs]].map(([name, text5]) => writeFile3(join6(dir, name), text5, { mode: 384 })));
    let size = 7;
    for (const text5 of [base, ours, theirs]) {
      for (const run of text5.matchAll(/<+|=+|>+/g)) size = Math.max(size, run[0].length + 1);
    }
    const result = await new Git(dir).run([
      "-c",
      "merge.conflictStyle=merge",
      "merge-file",
      "--stdout",
      `--marker-size=${size}`,
      "-L",
      "git",
      "-L",
      "base",
      "-L",
      "linear",
      "ours",
      "base",
      "theirs"
    ], { okCodes: Array.from({ length: 128 }, (_, i) => i) });
    const raw = result.stdout.toString("utf8");
    const tokens = tokenize(raw.replaceAll("\r\n", "\n"), size);
    const text4 = head + (result.code === 0 ? raw : render(tokens, conflictRanges(tokens))).replaceAll("\n", eol);
    return { text: text4, conflicts: detectConflicts(text4) };
  } finally {
    await rm3(dir, { recursive: true, force: true });
  }
}

// src/merge/structural.ts
var RETITLED_COMMENT = "The title was set back because the file was renamed in git at the same time. Rename it again to change it.";
var NO_LINEAR_STEPS = { restore: false, create: false, trash: false, retitle: false, write: false };
function lf(text4) {
  return text4.replaceAll("\r\n", "\n");
}
function body(text4) {
  return lf(splitFile(text4).body);
}
function samePath(a, b) {
  return a.normalize("NFC") === b.normalize("NFC");
}
function edited(version, base) {
  return lf(version.text) !== lf(base.text);
}
function renamed(version, base) {
  return !samePath(version.path, base.path);
}
function changed(version, base) {
  return edited(version, base) || renamed(version, base);
}
function summary(code2, text4, conflicts) {
  if (conflicts.length === 1) text4 += "; 1 text conflict is marked in the document";
  else if (conflicts.length > 1) text4 += `; ${conflicts.length} text conflicts are marked in the document`;
  return { code: code2, text: text4 };
}
async function resolveStructural(input) {
  const { base, git, linear } = input;
  if (git === null && linear === null) {
    return { kind: "both-deleted", path: null, text: null, conflicts: [], linear: { ...NO_LINEAR_STEPS }, git: "none", summary: null };
  }
  if (git === null) {
    const side = linear;
    if (!changed(side, base)) {
      return { kind: "git-deleted", path: null, text: null, conflicts: [], linear: { ...NO_LINEAR_STEPS, trash: true }, git: "none", summary: null };
    }
    const conflicts = detectConflicts(side.text);
    return {
      kind: "git-deleted-linear-changed",
      path: side.path,
      text: side.text,
      conflicts,
      linear: { ...NO_LINEAR_STEPS },
      git: "restore",
      summary: summary(
        "edit-wins-delete",
        `${side.path}: deleted in git but changed in Linear; the document is kept and its file comes back through the sync pull request`,
        conflicts
      )
    };
  }
  if (linear === null) {
    if (!changed(git, base)) {
      return { kind: "linear-deleted", path: null, text: null, conflicts: [], linear: { ...NO_LINEAR_STEPS }, git: "delete", summary: null };
    }
    const gone = input.linearGone === true;
    const conflicts = detectConflicts(git.text);
    return {
      kind: "linear-deleted-git-changed",
      path: git.path,
      text: git.text,
      conflicts,
      // A restore keeps the document's comments exactly as they were; the
      // run summary, not a new comment, reports it.
      linear: gone ? { ...NO_LINEAR_STEPS, create: true, write: true } : { ...NO_LINEAR_STEPS, restore: true, retitle: true, write: true },
      git: "none",
      summary: summary("edit-wins-delete", gone ? `${git.path}: deleted in Linear but changed in git; the document was gone from Linear, so a new one was created with the git text and its old comments are lost` : `${git.path}: deleted in Linear but changed in git; the document is restored with the git text`, conflicts)
    };
  }
  const gitRenamed = renamed(git, base);
  const linearRenamed = renamed(linear, base);
  const merged = await mergeMarkdown(base.text, git.text, linear.text);
  const path2 = gitRenamed ? git.path : linear.path;
  const write = body(merged.text) !== body(linear.text);
  const result = (kind, steps, gitStep, entry) => ({
    kind,
    path: path2,
    text: merged.text,
    conflicts: merged.conflicts,
    linear: { ...NO_LINEAR_STEPS, write, ...steps },
    git: gitStep,
    summary: entry === null ? null : summary(entry[0], entry[1], merged.conflicts)
  });
  if (!gitRenamed && !linearRenamed) return result("none", {}, "none", null);
  if (gitRenamed && !linearRenamed) {
    return result("git-renamed", { retitle: true }, "none", edited(linear, base) ? ["rename-and-edit", `${base.path} \u2192 ${path2}: renamed in git and edited in Linear; both applied`] : null);
  }
  if (!gitRenamed) {
    return result("linear-renamed", {}, "move", edited(git, base) ? ["rename-and-edit", `${base.path} \u2192 ${path2}: renamed in Linear and edited in git; both applied`] : null);
  }
  if (samePath(git.path, linear.path)) return result("same-rename", {}, "none", null);
  return result("different-renames", { retitle: true, comment: RETITLED_COMMENT }, "none", [
    "git-path-wins",
    `${base.path}: renamed to ${git.path} in git and to ${linear.path} in Linear; the git path wins and the Linear title is set back`
  ]);
}

// src/sync/marks.ts
var MARKS = {
  conflict: { icon: "Alert", color: "#F2994A" },
  blocked: { icon: "Cross", color: "#EB5757" }
};
var CONFLICT_COMMENT = "This document contains conflicting versions. Edit the document here or in Git, keep the text you want, and remove every conflict marker paragraph throughout the document. The alert clears after the next sync.";
var BLOCKED_COMMENT = "Security checks rejected this document. Fix the listed findings and sync again.";
function blockedComment(findings) {
  const locations = [...new Set(findings.map(({ hook, line: line2 }) => {
    const name = /^[a-zA-Z0-9_.-]{1,128}$/.test(hook) ? hook : "security-check";
    const location = Number.isSafeInteger(line2) && line2 > 0 ? `, line ${line2}` : "";
    return `- Hook \`${name}\`${location}.`;
  }))].sort();
  return `${BLOCKED_COMMENT}

${locations.join("\n")}`;
}
async function reconcileDocumentMark(options) {
  const { document: document4, linear, persistEntry } = options;
  if (document4.id !== options.entry.id) throw new Error("Document and id entry do not match");
  if (document4.content === void 0) throw new Error("Status reconciliation requires document content");
  let entry = structuredClone(options.entry);
  const blocked = options.blocked ?? [];
  const state = blocked.length > 0 ? "blocked" : detectConflicts(document4.content ?? "").length > 0 ? "conflict" : "clear";
  const result = { state, entry, updated: false, commented: false };
  if (document4.trashed || document4.archivedAt !== null) return result;
  if (state === "clear") {
    if (entry.saved === void 0) return result;
    if (document4.icon !== entry.saved.icon || document4.color !== entry.saved.color) {
      await linear.updateDocument(document4.id, { icon: entry.saved.icon, color: entry.saved.color });
      result.updated = true;
    }
    const { saved: _saved, ...restored } = entry;
    await persistEntry(restored);
    result.entry = restored;
    return result;
  }
  if (!document4.documentContentId) throw new Error("A marked document requires a comment target");
  const body2 = state === "conflict" ? CONFLICT_COMMENT : blockedComment(blocked);
  const bodyHash = createHash7("sha256").update(body2).digest("hex");
  const saved = entry.saved ?? { icon: document4.icon, color: document4.color };
  const previous3 = saved.notice;
  const notice = previous3?.kind === state ? { ...previous3, bodyHash, posted: previous3.posted && previous3.bodyHash === bodyHash } : { id: randomUUID2(), kind: state, bodyHash, posted: false };
  if (entry.saved === void 0 || previous3?.kind !== state || previous3.bodyHash !== bodyHash) {
    entry = { ...entry, saved: { ...saved, notice } };
    await persistEntry(entry);
    result.entry = entry;
  }
  const mark2 = MARKS[state];
  if (document4.icon !== mark2.icon || document4.color !== mark2.color) {
    await linear.updateDocument(document4.id, mark2);
    result.updated = true;
  }
  if (notice.posted) return result;
  const comment = await linear.ensureDocumentComment(document4.documentContentId, body2, notice.id, true);
  const posted = { ...entry, saved: { ...saved, notice: { ...notice, posted: true } } };
  await persistEntry(posted);
  result.entry = posted;
  result.commented = comment.created;
  return result;
}

// src/sync/merge.ts
async function mergeLocally(git, linear, tracked, ids, facts = LINEAR_FACTS, options = {}) {
  const { base, renames, resolved } = await mergeWithMarkers(git, linear, tracked, ids, options.knownId);
  const { tree, unresolved: conflicts } = resolved;
  const linearSide = await synchronizedFiles(git, linear, facts);
  const resultSide = await synchronizedFiles(git, tree, facts);
  const conflicted = new Set(conflicts);
  const changes = [];
  const unchanged = [];
  const held = [];
  const claimed = /* @__PURE__ */ new Set();
  const blobs = await readBlobs(git, [...linearSide.files.values(), ...resultSide.files.values()].map((file) => file.oid));
  const body2 = (oid) => splitFile(blobs.get(oid).toString("utf8")).body;
  for (const [from, entry] of [...ids].sort(([a], [b]) => compare7(a, b))) {
    if (conflicted.has(from)) {
      claimed.add(from);
      continue;
    }
    let to;
    const decidedPath = resolved.moves.get(from);
    if (decidedPath !== void 0 && resultSide.files.has(decidedPath) && !ids.has(decidedPath)) to = decidedPath;
    else if (resultSide.files.has(from)) to = from;
    else {
      const renamed2 = renames.get(from);
      if (renamed2 !== void 0 && !ids.has(renamed2) && !claimed.has(renamed2)) {
        if (resultSide.files.has(renamed2) && !conflicted.has(renamed2)) to = renamed2;
        else if (conflicted.has(renamed2) || resultSide.leftOutPaths.has(renamed2)) {
          claimed.add(renamed2);
          held.push({ id: entry.id, from, to: renamed2 });
          continue;
        }
      }
    }
    if (to === void 0) {
      if (resultSide.leftOutPaths.has(from)) continue;
      changes.push({ kind: "trash", id: entry.id, path: from });
      continue;
    }
    claimed.add(to);
    const next = resultSide.files.get(to);
    const previous3 = linearSide.files.get(from);
    const change = {
      kind: "keep",
      id: entry.id,
      from,
      to,
      content: previous3 === void 0 || body2(previous3.oid) !== body2(next.oid),
      title: previous3 === void 0 || previous3.title.normalize("NFC") !== next.title.normalize("NFC"),
      place: previous3 === void 0 || placeKey2(previous3.place) !== placeKey2(next.place)
    };
    const comment = resolved.comments.get(from);
    if (comment !== void 0 && (change.title || change.place)) change.comment = comment;
    if (change.content || change.title || change.place) changes.push(change);
    else unchanged.push(change);
  }
  for (const path2 of resultSide.files.keys()) {
    if (!claimed.has(path2) && !conflicted.has(path2)) {
      const file = resultSide.files.get(path2);
      const previous3 = linearSide.files.get(path2);
      const unchanged2 = previous3 !== void 0 && body2(previous3.oid) === body2(file.oid);
      const kept = unchanged2 && (body2(file.oid) === "" || options.keptAnnotations?.has(path2) === true);
      if ((path2 === "README.md" || path2.endsWith("/README.md")) && kept) {
        const annotation = readAnnotation(path2, blobs.get(file.oid).toString("utf8"));
        if ("annotation" in annotation && annotation.annotation !== null) continue;
      }
      const restore = resolved.restores.get(path2);
      changes.push(restore === void 0 ? { kind: "create", path: path2 } : { kind: "create", path: path2, restore });
    }
  }
  changes.sort((a, b) => compare7(changePath(a), changePath(b)));
  return {
    base,
    tree,
    conflicts,
    marked: resolved.marked.filter((path2) => resultSide.files.has(path2)).sort(compare7),
    decided: resolved.decided,
    linear: linearSide.files,
    result: resultSide.files,
    leftOut: resultSide.leftOut,
    changes,
    unchanged: unchanged.sort((a, b) => compare7(a.to, b.to)),
    held,
    texts: blobs
  };
}
var ID_HISTORY_DEPTH = 100;
function knownIdLookup(git, idsCommit, ids) {
  let history;
  const versions = /* @__PURE__ */ new Map();
  return async (path2) => {
    const current = ids.get(path2);
    if (current !== void 0) return current.id;
    history ??= idsCommit === null ? [] : (await git.text(["rev-list", "--first-parent", "-n", String(ID_HISTORY_DEPTH), idsCommit])).split("\n").filter(Boolean);
    for (const commit of history) {
      let map = versions.get(commit);
      if (map === void 0) {
        map = await readIds(git, commit);
        versions.set(commit, map);
      }
      const entry = map.get(path2);
      if (entry !== void 0) return entry.id;
    }
    return void 0;
  };
}
async function mergeWithMarkers(git, linearSide, gitSide, ids, knownId) {
  const base = await git.text(["merge-base", linearSide, gitSide]);
  const merged = await git.run(["merge-tree", "--write-tree", "--name-only", "--no-messages", "-z", linearSide, gitSide], { okCodes: [0, 1] });
  const [gitTree, ...rest] = merged.stdout.toString("utf8").split("\0");
  if (gitTree === void 0 || !/^[0-9a-f]{40,64}$/.test(gitTree)) throw new Error("git merge-tree gave no tree");
  const unmerged = [...new Set(rest.filter((path2) => path2 !== ""))].sort(compare7);
  const renames = await renamesBetween(git, base, gitSide);
  const resolved = await resolveConflicts(git, { base, linear: linearSide, tracked: gitSide, tree: gitTree, unmerged, renames, ids, knownId });
  return { base, renames, resolved };
}
function changePath(change) {
  return change.kind === "keep" ? change.to : change.path;
}
function placeKey2(place) {
  return place.kind === "project" ? `project\0${place.team}\0${place.project}` : `team\0${place.team}`;
}
async function synchronizedFiles(git, treeish, facts) {
  const mapping = await loadMapping(git, treeish);
  const blobs = await readBlobs(git, mapping.documents.map((document4) => document4.oid));
  const files = /* @__PURE__ */ new Map();
  const leftOut = [];
  const leave = (path2, rules) => leftOut.push({ path: path2, rules: [...new Set(rules)].sort() });
  for (const document4 of mapping.documents) {
    const rules = lintText(document4.path, blobs.get(document4.oid).toString("utf8")).map((finding) => finding.rule);
    if (lengthRefusal({ title: document4.title }, facts) !== void 0) rules.push("title-too-long");
    if (rules.length > 0) leave(document4.path, rules);
    else files.set(document4.path, toSideFile(document4));
  }
  for (const file of mapping.leftOut) leave(file.path, [file.rule]);
  for (const file of mapping.unsynced) if (file.place !== void 0) leave(file.path, [file.reason]);
  leftOut.sort((a, b) => compare7(a.path, b.path));
  return { mapping, files, leftOut, leftOutPaths: new Set(leftOut.map((entry) => entry.path)) };
}
async function leftOutFiles(git, treeish, facts = LINEAR_FACTS) {
  return (await synchronizedFiles(git, treeish, facts)).leftOut;
}
var BASELINE_DEPTH = 20;
async function lastSynchronized(git, linear, path2, facts = LINEAR_FACTS) {
  const log = await git.text(["log", "--first-parent", "--format=%H", "-n", String(BASELINE_DEPTH), linear, "--", path2]);
  for (const commit of log.split("\n").filter(Boolean)) {
    const file = (await synchronizedFiles(git, commit, facts)).files.get(path2);
    if (file !== void 0) return { commit, file, text: (await readBlobs(git, [file.oid])).get(file.oid).toString("utf8") };
  }
  return null;
}
function toSideFile(document4) {
  return { path: document4.path, oid: document4.oid, title: document4.title, place: document4.place };
}
async function resolveConflicts(git, input) {
  const out = { tree: input.tree, unresolved: [], moves: /* @__PURE__ */ new Map(), comments: /* @__PURE__ */ new Map(), restores: /* @__PURE__ */ new Map(), marked: [], decided: [] };
  if (input.unmerged.length === 0) return out;
  const [baseFiles, gitFiles, linearFiles] = await Promise.all([filesOf(git, input.base), filesOf(git, input.tracked), filesOf(git, input.linear)]);
  const mapped = /* @__PURE__ */ new Set();
  for (const side of [input.base, input.tracked, input.linear]) for (const document4 of (await loadMapping(git, side)).documents) mapped.add(document4.path);
  const linearRenames = await renamesBetween(git, input.base, input.linear);
  const pathById = new Map([...input.ids].map(([path2, entry]) => [entry.id, path2]));
  const knownId = async (path2) => input.knownId?.(path2);
  const basePathOf = (path2) => {
    if (baseFiles.has(path2)) return path2;
    for (const [from, to] of [...input.renames, ...linearRenames]) if (to === path2 && baseFiles.has(from)) return from;
    return null;
  };
  const linearPathOf = async (basePath) => {
    const id = await knownId(basePath);
    const byId = id === void 0 ? void 0 : pathById.get(id);
    if (byId !== void 0 && linearFiles.has(byId)) return byId;
    const renamed2 = linearRenames.get(basePath);
    if (renamed2 !== void 0 && linearFiles.has(renamed2)) return renamed2;
    if (!linearFiles.has(basePath)) return null;
    if (id !== void 0 && byId === void 0 && await annotationOnly(basePath)) {
      removedCarriers.add(basePath);
      return null;
    }
    return basePath;
  };
  const removedCarriers = /* @__PURE__ */ new Set();
  const annotationOnly = async (path2) => {
    if (path2 !== "README.md" && !path2.endsWith("/README.md")) return false;
    const text4 = (await readBlobs(git, [linearFiles.get(path2)])).get(linearFiles.get(path2)).toString("utf8");
    if (splitFile(text4).body.trim() !== "") return false;
    const annotation = readAnnotation(path2, text4);
    return "annotation" in annotation && annotation.annotation !== null;
  };
  const groups = [];
  const seen = /* @__PURE__ */ new Set();
  for (const path2 of input.unmerged) {
    if (seen.has(path2)) continue;
    const basePath = basePathOf(path2);
    const gitPath = basePath === null ? gitFiles.has(path2) ? path2 : null : input.renames.get(basePath) ?? (gitFiles.has(basePath) ? basePath : null);
    const linearPath = basePath === null ? linearFiles.has(path2) ? path2 : null : await linearPathOf(basePath);
    const involved = [...new Set([path2, basePath, gitPath, linearPath].filter((entry) => entry !== null))];
    for (const entry of involved) seen.add(entry);
    const collides = involved.some((entry) => linearFiles.has(entry) && entry !== linearPath && !removedCarriers.has(entry) || gitFiles.has(entry) && entry !== gitPath);
    if (!collides && involved.every((entry) => mapped.has(entry) || !input.unmerged.includes(entry))) groups.push({ basePath, gitPath, linearPath, involved });
    else out.unresolved.push(...involved);
  }
  const blobs = await readBlobs(git, groups.flatMap(({ basePath, gitPath, linearPath }) => [
    ...basePath === null ? [] : [baseFiles.get(basePath)],
    ...gitPath === null ? [] : [gitFiles.get(gitPath)],
    ...linearPath === null ? [] : [linearFiles.get(linearPath)]
  ]));
  const version = (files, path2) => path2 === null ? null : { path: path2, text: blobs.get(files.get(path2)).toString("utf8") };
  const changes = /* @__PURE__ */ new Map();
  for (const { basePath, gitPath, linearPath, involved } of groups) {
    const versions = {
      // Both sides added the path: an empty base, so the whole text is merged.
      base: version(baseFiles, basePath) ?? { path: involved[0], text: "" },
      git: version(gitFiles, gitPath),
      linear: version(linearFiles, linearPath)
    };
    const result = await resolveStructural(versions);
    for (const path2 of involved) changes.set(path2, null);
    if (result.path !== null && result.text !== null) changes.set(result.path, result.text);
    if (linearPath !== null && result.path !== null && result.path !== linearPath) out.moves.set(linearPath, result.path);
    if (linearPath !== null && result.linear.comment !== void 0) out.comments.set(linearPath, result.linear.comment);
    let summary2 = result.summary;
    if (result.kind === "linear-deleted-git-changed" && result.path !== null) {
      const gone = (await resolveStructural({ ...versions, linearGone: true })).summary;
      const id = basePath === null ? void 0 : await knownId(basePath);
      if (id !== void 0) out.restores.set(result.path, { id, gone });
      else summary2 = gone;
    }
    if (result.path !== null && result.conflicts.length > 0) out.marked.push(result.path);
    if (summary2 !== null) out.decided.push({ path: result.path ?? basePath ?? involved[0], summary: summary2 });
  }
  out.tree = await buildTree(git, input.tree, changes);
  out.unresolved.sort(compare7);
  return out;
}
async function renamesBetween(git, from, to) {
  const { stdout } = await git.run(["diff", "--no-ext-diff", "--no-textconv", "--find-renames", "--diff-filter=R", "--name-status", "-z", from, to]);
  const parts = stdout.toString("utf8").split("\0");
  const renames = /* @__PURE__ */ new Map();
  for (let index2 = 0; index2 + 2 < parts.length; index2 += 3) {
    const [status, old, renamed2] = [parts[index2], parts[index2 + 1], parts[index2 + 2]];
    if (status?.startsWith("R") && old !== void 0 && renamed2 !== void 0) renames.set(old, renamed2);
  }
  return renames;
}
async function alreadyMerged(git, linear, tracked) {
  return (await git.run(["merge-base", "--is-ancestor", tracked, linear], { okCodes: [0, 1] })).code === 0;
}
async function mergedInitialRecord(git, linear, tracked) {
  const [subject] = (await git.text(["show", "-s", "--format=%s", linear])).split("\n");
  if (subject !== INITIAL_SYNC_FROM_LINEAR_RECORD) return false;
  if (!await isAncestor(git, linear, tracked)) return false;
  const [linearTree, trackedTree] = (await git.text(["rev-parse", `${linear}^{tree}`, `${tracked}^{tree}`])).split("\n");
  return linearTree === trackedTree;
}
async function filesOf(git, treeish) {
  return new Map((await listTree(git, treeish)).map((entry) => [entry.path, entry.oid]));
}
function compare7(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

// src/sync/rebuild.ts
async function rebuildIds({ linear, facts, targets, documents }) {
  const keyOf = (place, title) => `${"projectId" in place ? `project:${place.projectId}` : `team:${place.teamId}`}\0${title.normalize("NFC")}`;
  const files = /* @__PURE__ */ new Map();
  const places = /* @__PURE__ */ new Map();
  const byPlace = /* @__PURE__ */ new Map();
  for (const document4 of documents) {
    if (lintText(document4.path, document4.text).length > 0 || lengthRefusal({ title: document4.title }, facts) !== void 0) continue;
    let place;
    try {
      place = placeId(targets, document4.place);
    } catch {
      continue;
    }
    places.set(JSON.stringify(place), place);
    files.set(keyOf(place, document4.title), document4.path);
    const folder = document4.path.slice(0, -(document4.title.length + ".md".length)).replace(/\/$/, "");
    byPlace.set(JSON.stringify(place), [...byPlace.get(JSON.stringify(place)) ?? [], { folder, path: document4.path }]);
  }
  const allPaths = new Set(documents.map((document4) => document4.path));
  const ids = /* @__PURE__ */ new Map();
  const listed = await linear.listDocumentsInPlaces([...places.values()], { includeArchived: true });
  const gone = (document4) => document4.trashed || document4.archivedAt !== null;
  const order = listed.sort((a, b) => Number(gone(a)) - Number(gone(b)) || compare8(a.createdAt, b.createdAt) || compare8(a.id, b.id));
  const unmatched = [];
  for (const document4 of order) {
    if (document4.projectId === null && document4.teamId === null) continue;
    const place = document4.projectId !== null ? { projectId: document4.projectId } : { teamId: document4.teamId };
    const path2 = files.get(keyOf(place, document4.title));
    if (path2 !== void 0 && !ids.has(path2)) ids.set(path2, { id: document4.id });
    else unmatched.push({ document: document4, place });
  }
  const leftFiles = new Map([...byPlace].map(([place, list2]) => [place, list2.filter(({ path: path2 }) => !ids.has(path2))]));
  const taken = new Set([...ids.values()].map((entry) => entry.id));
  for (const { document: document4, place } of unmatched) {
    const candidates = leftFiles.get(JSON.stringify(place)) ?? [];
    if (taken.has(document4.id) || candidates.length === 0) continue;
    const index2 = candidates.findIndex(({ folder, path: path2 }) => documentPath(folder, document4.title, document4.id, new Set([...allPaths].filter((other) => other !== path2)), path2) === path2);
    if (index2 < 0) continue;
    ids.set(candidates[index2].path, { id: document4.id });
    taken.add(document4.id);
    candidates.splice(index2, 1);
  }
  return ids;
}
function compare8(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

// src/sync/capture.ts
var CURSOR = /^Capture-through: (\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z)$/m;
function captureCursorTrailer(through) {
  return `Capture-through: ${through}`;
}
function cursorTime(document4) {
  return recordedTime(document4.updatedAt);
}
var HELD = /^Removal-held: (\S+)$/gm;
async function readHeld(context, state) {
  if (state.ids === null) return /* @__PURE__ */ new Set();
  const log = await context.git.text(["log", "--format=%B", "--grep=^Capture document ids", "-1", state.ids]);
  return new Set([...log.matchAll(HELD)].map((match) => match[1]));
}
async function readCaptureCursor(git, ids) {
  if (ids === null) return null;
  const log = await git.text(["log", "--format=%B", "--grep=^Capture-through:", "-1", ids]);
  return CURSOR.exec(log)?.[1] ?? null;
}
async function capture(context, options) {
  const { git, linear, fetched } = context;
  let mapping = context.mapping;
  let targets = context.targets;
  const state = { ...options.state };
  const base = state.linear;
  if (base === null) throw new Error("run initial sync first");
  const identity = options.identity ?? SYNC_IDENTITY;
  const ids = await readIds(git, state.ids);
  const uploads = await readUploads(git, state.uploads);
  const reserved = await readReservedIds(git, state.ids);
  const gate = options.security ?? await securityGate(git, fetched.tracked);
  const result = { ok: true, state, documents: /* @__PURE__ */ new Map(), blocked: [], changed: [], removed: [], heldRemovals: [], leftOut: [], writeBackWarnings: [], summary: "" };
  let published = false;
  try {
    const recorded = await loadMapping(git, base);
    const zones = new Map(mapping.zones);
    let changedPlace = false;
    for (const [folder, old] of recorded.zones) {
      const current = zones.get(folder);
      if (current !== void 0 && (old.team !== current.team || old.project !== current.project)) {
        zones.set(folder, old);
        changedPlace = true;
      }
    }
    if (changedPlace) {
      mapping = { ...mapping, zones };
      const resolved = await resolveTargets(linear, zones.values());
      if (resolved.targets === void 0) throw new Error("the previously recorded document places could not be resolved");
      targets = resolved.targets;
    }
    if (state.ids === null) {
      const texts = await readBlobs(git, recorded.documents.map((document4) => document4.oid));
      const documents2 = recorded.documents.map((document4) => ({ ...document4, text: texts.get(document4.oid).toString("utf8") }));
      for (const [path2, entry] of await rebuildIds({ linear, facts: linear.facts, targets, documents: documents2 })) ids.set(path2, entry);
      result.rebuiltIds = { matched: ids.size, files: recorded.documents.length };
    }
    const cursor = await readCaptureCursor(git, state.ids);
    const entries = await listTree(git, base);
    const textEntries = entries.filter((entry) => entry.type === "blob" && ids.has(entry.path));
    const blobs = await readBlobs(git, textEntries.map((entry) => entry.oid));
    const previous3 = new Map(textEntries.map((entry) => [entry.path, blobs.get(entry.oid)]));
    const byId = new Map([...ids].map(([path2, entry]) => [entry.id, { path: path2, entry }]));
    const reservedById = new Map([...reserved].filter(([path2, id]) => !ids.has(path2) && !byId.has(id)).map(([path2, id]) => [id, path2]));
    const occupied = /* @__PURE__ */ new Set([...entries.map((entry) => entry.path), ...ids.keys()]);
    const annotationHead = (path2) => {
      if (posix7.basename(path2) !== "README.md" || !mapping.zones.has(folderOf(path2))) return void 0;
      const prior = previous3.get(path2)?.toString("utf8");
      if (prior === void 0) return void 0;
      const read = readAnnotation(path2, prior);
      return "annotation" in read && read.annotation !== null ? splitFile(prior).head : void 0;
    };
    const listed = /* @__PURE__ */ new Map();
    const folders = /* @__PURE__ */ new Map();
    const places = annotatedPlaces(mapping.zones).map(({ place, folder }) => {
      const resolved = placeId(targets, place);
      folders.set(placeKeyOf(resolved), folder);
      return resolved;
    });
    const recordedPlace = (path2) => {
      const zone = nearestZone(mapping.zones, folderOf(path2));
      if (zone === void 0) return void 0;
      const resolved = placeId(targets, zone.project === void 0 ? { kind: "team", team: zone.team } : { kind: "project", team: zone.team, project: zone.project });
      return placeKeyOf(resolved);
    };
    const inPlaces = await linear.listDocumentsInPlaces(places, { includeArchived: true });
    for (const document4 of inPlaces) listed.set(document4.id, document4);
    if (!changedPlace) result.containers = containersOf(context, inPlaces);
    const missing = [...byId.keys()].filter((id) => !listed.has(id));
    for (const document4 of await linear.getDocuments(missing)) listed.set(document4.id, document4);
    const notFound = [];
    for (const id of missing.filter((id2) => !listed.has(id2))) {
      const document4 = await linear.getDocument(id);
      if (document4 === null) notFound.push(id);
      else listed.set(id, document4);
    }
    const answered = new Set(inPlaces.map(placeKeyOf));
    const heldBefore = await readHeld(context, state);
    const gone = /* @__PURE__ */ new Set();
    const held = /* @__PURE__ */ new Set();
    for (const id of notFound) {
      const place = recordedPlace(byId.get(id).path);
      if (place !== void 0 && answered.has(place) || heldBefore.has(id) && answered.size > 0) gone.add(id);
      else held.add(id);
    }
    const baselines = /* @__PURE__ */ new Map();
    const excludedPath = (path2) => {
      const mapped = recorded.documents.find((document4) => document4.path === path2);
      const prior = previous3.get(path2);
      return mapped === void 0 || prior !== void 0 && lintText(path2, prior.toString("utf8")).length > 0 || lengthRefusal({ title: mapped.title }, linear.facts) !== void 0;
    };
    const retained = /* @__PURE__ */ new Map();
    for (const [id, old] of byId) {
      if (!excludedPath(old.path)) continue;
      const baseline = await lastSynchronized(git, base, old.path, linear.facts);
      baselines.set(old.path, baseline);
      const doc = listed.get(id);
      if (baseline === null || doc === void 0 || doc.title.normalize("NFC") !== baseline.file.title.normalize("NFC")) continue;
      let resolved;
      try {
        resolved = placeId(targets, baseline.file.place);
      } catch {
        const place = baseline.file.place;
        const lookup = await resolveTargets(linear, [{ team: place.team, teamFolder: "", ...place.kind === "project" ? { project: place.project, projectFolder: "" } : {} }]);
        if (lookup.targets === void 0) continue;
        resolved = placeId(lookup.targets, place);
      }
      if ("projectId" in resolved ? resolved.projectId === doc.projectId : doc.projectId === null && resolved.teamId === doc.teamId) retained.set(id, old.path);
    }
    const folderFor = (doc) => folders.get(placeKeyOf(doc));
    const live = (doc) => !doc.trashed && doc.archivedAt === null && (folderFor(doc) !== void 0 || retained.has(doc.id));
    const normalizedTime = cursorTime;
    const recordedTimes = await readRecorded(git, state.ids);
    const asRecorded = (doc) => recordedTimes.get(doc.id) === normalizedTime(doc);
    let selected = [...listed.values()].filter((doc) => !byId.has(doc.id) || byId.get(doc.id)?.entry.saved !== void 0 || !asRecorded(doc) && (cursor === null || normalizedTime(doc) >= cursor));
    const invalidZone = (doc, path2) => {
      const zone = nearestZone(mapping.zones, folderOf(path2));
      if (zone === void 0) return true;
      const place = zone.project === void 0 ? { kind: "team", team: zone.team } : { kind: "project", team: zone.team, project: zone.project };
      const target = placeId(targets, place);
      return "projectId" in target ? target.projectId !== doc.projectId : doc.projectId !== null || target.teamId !== doc.teamId;
    };
    const destination2 = (doc, occupied2, allocated2 = /* @__PURE__ */ new Map()) => {
      if (retained.has(doc.id)) return retained.get(doc.id);
      const own3 = reservedById.get(doc.id);
      if (own3 !== void 0 && !occupied2.has(own3) && !allocated2.has(own3) && !invalidZone(doc, own3)) return own3;
      const old = byId.get(doc.id);
      const available = new Set(occupied2);
      if (old !== void 0 && (!allocated2.has(old.path) || allocated2.get(old.path) === doc.id)) available.delete(old.path);
      return documentPath(folderFor(doc), doc.title, doc.id, available, old?.path, (path2) => invalidZone(doc, path2));
    };
    if (gone.size > 0 || [...listed.values()].some((doc) => {
      const old = byId.get(doc.id);
      return old !== void 0 && (!live(doc) || destination2(doc, occupied) !== old.path);
    })) selected = [...listed.values()];
    const documents = new Map(listed);
    const work = /* @__PURE__ */ new Map();
    for (const doc of await linear.getDocuments(selected.filter(live).map((doc2) => doc2.id), { withContent: true })) {
      documents.set(doc.id, doc);
      work.set(doc.id, doc);
    }
    for (const doc of selected) if (!live(doc)) work.set(doc.id, doc);
    result.documents = documents;
    const changes = /* @__PURE__ */ new Map();
    const removeBody = (path2) => changes.set(path2, annotationHead(path2) ?? null);
    const documentIds = new Map([...ids].filter(([path2]) => previous3.has(path2)).map(([path2, entry]) => [path2, entry.id]));
    for (const [id, path2] of reservedById) if (!documentIds.has(path2)) documentIds.set(path2, id);
    for (const id of gone) {
      const old = byId.get(id);
      removeBody(old.path);
      ids.delete(old.path);
      documentIds.delete(old.path);
      result.removed.push(old.path);
    }
    for (const id of held) result.heldRemovals.push(byId.get(id).path);
    const paths = /* @__PURE__ */ new Map();
    const reservations = new Set(occupied);
    const allocated = /* @__PURE__ */ new Map();
    const reservedFirst = (a, b) => Number(reservedById.has(b.id)) - Number(reservedById.has(a.id)) || a.id.localeCompare(b.id);
    for (const doc of [...work.values()].filter(live).sort(reservedFirst)) {
      const path2 = destination2(doc, reservations, allocated);
      allocated.set(path2, doc.id);
      paths.set(doc.id, path2);
      reservations.add(path2);
    }
    const linkBase = [...work.values()].some((doc) => linksLinearDocuments(doc.content ?? "")) ? documentUrlBase(await workspaceUrlKey(linear)) : void 0;
    const downloadAssets = createAssetCapture(git, options.config, base, options.fetch ?? ((input, init) => linear.transport.fetchUpload(String(input), init)), linear.transport.reads);
    const candidates = /* @__PURE__ */ new Map();
    const resetTarget = (id, targets2 = documentIds) => {
      for (const [path2, target] of targets2) if (target === id) targets2.delete(path2);
      const old = byId.get(id);
      if (old !== void 0 && previous3.has(old.path)) targets2.set(old.path, id);
    };
    for (const doc of [...work.values()].sort((a, b) => a.id.localeCompare(b.id))) {
      const old = byId.get(doc.id);
      if (!live(doc)) {
        if (old !== void 0) {
          if (old.entry.saved !== void 0 && options.stageOnly !== true) await linear.updateDocument(doc.id, { icon: old.entry.saved.icon, color: old.entry.saved.color });
          removeBody(old.path);
          ids.delete(old.path);
          documentIds.delete(old.path);
          result.removed.push(old.path);
        }
        continue;
      }
      const path2 = paths.get(doc.id);
      const prior = splitFile(old === void 0 ? "" : previous3.get(old.path)?.toString("utf8") ?? "");
      const head = old !== void 0 && path2 !== old.path && annotationHead(old.path) !== void 0 ? relocatedHead(prior.head) : prior.head;
      try {
        const assets = await downloadAssets(path2, doc.content ?? "", uploads, old === void 0 ? void 0 : prior.body, old?.path);
        const candidate = { doc, path: path2, head, assets, files: new Map([[path2, head + assets.body], ...assets.files]) };
        if (old?.path === path2) candidate.previousBody = prior.body;
        candidates.set(doc.id, candidate);
        resetTarget(doc.id);
        if (old !== void 0) documentIds.delete(old.path);
        documentIds.set(path2, doc.id);
      } catch (error) {
        if (error instanceof LinearStoppedError) throw error;
        result.leftOut.push({ id: doc.id, rule: "capture-translation" });
      }
    }
    const textOf = (candidate, targets2) => {
      let body2 = candidate.assets.body;
      if (linkBase !== void 0) {
        const map = { base: linkBase, ids: new Map(targets2) };
        const seen = /* @__PURE__ */ new Map();
        if (candidate.previousBody !== void 0) linksToLinear(candidate.previousBody, candidate.path, map, seen);
        body2 = linksFromLinear(body2, candidate.path, map, seen);
      }
      if (candidate.compared?.body !== body2) {
        const { assets } = candidate;
        const newAssets = assets.files.size > 0 || [...assets.uploads].some(([hash, url]) => uploads.get(hash) !== url);
        candidate.compared = { body: body2, same: candidate.previousBody !== void 0 && !newAssets && sameMarkdown(candidate.previousBody, body2) };
      }
      return candidate.head + (candidate.compared.same ? candidate.previousBody : body2);
    };
    let again = true;
    while (again) {
      again = false;
      for (const [id, candidate] of candidates) {
        const { doc, path: path2, head, assets } = candidate;
        const old = byId.get(id);
        const text4 = textOf(candidate, documentIds);
        candidate.files.set(path2, text4);
        if (candidate.checked === text4) continue;
        const unchanged = old?.path === path2 && previous3.get(path2)?.equals(Buffer.from(text4)) === true && assets.files.size === 0 && assets.uploads.size === 0;
        let findings = [];
        if (!unchanged || old?.entry.saved !== void 0) {
          const original = head + (doc.content ?? "");
          if (original !== text4) findings = await gate.check(new Map([[path2, original], ...assets.files]));
          if (findings?.length === 0) findings = await gate.check(candidate.files);
        }
        if (findings === null) {
          result.leftOut.push({ id, rule: "security-unchecked" });
          candidates.delete(id);
          resetTarget(id);
          again = true;
          break;
        }
        if (findings.length > 0) {
          const saved = old?.entry.saved ?? { icon: doc.icon, color: doc.color };
          ids.set(old?.path ?? path2, { id, saved });
          result.blocked.push({ id, path: old?.path ?? path2, findings });
          candidates.delete(id);
          resetTarget(id);
          again = true;
          break;
        }
        candidate.checked = text4;
      }
    }
    linear.transport.reads?.end();
    if (options.stageOnly === true) {
      if (linkBase !== void 0) for (const set of linkVariants(candidates, textOf, resetTarget, documentIds)) await gate.check(set);
      result.summary = `Staged ${candidates.size} changed documents for the security hooks.`;
      return result;
    }
    const unmarked = /* @__PURE__ */ new Set();
    if (linear.transport.reads?.mode === "replay") {
      const marking = [
        ...result.blocked.map(({ id }) => id),
        ...[...candidates].filter(([id, { doc }]) => byId.get(id)?.entry.saved !== void 0 || detectConflicts(doc.content ?? "").length > 0).map(([id]) => id)
      ];
      const current = marking.length === 0 ? /* @__PURE__ */ new Map() : new Map((await linear.getDocuments(marking, { withContent: true })).map((doc) => [doc.id, doc]));
      for (const blocked of result.blocked) {
        const now = current.get(blocked.id);
        const then = documents.get(blocked.id);
        if (now === void 0 || then === void 0 || now.updatedAt === then.updatedAt) continue;
        documents.set(blocked.id, { ...now, content: then.content ?? null });
        const entry = ids.get(blocked.path);
        if (entry !== void 0 && byId.get(blocked.id)?.entry.saved === void 0) ids.set(blocked.path, { ...entry, saved: { icon: now.icon, color: now.color } });
      }
      for (const [id, { doc }] of candidates) if (marking.includes(id) && current.get(id)?.updatedAt !== doc.updatedAt) unmarked.add(id);
    }
    for (const [id, candidate] of candidates) {
      const old = byId.get(id);
      if (old !== void 0 && old.path !== candidate.path) {
        removeBody(old.path);
        ids.delete(old.path);
        result.removed.push(old.path);
      }
      ids.set(candidate.path, old?.entry ?? { id });
      for (const [path2, content4] of candidate.files) {
        const prior = previous3.get(path2);
        if (path2 === candidate.path && old?.path === path2 && prior !== void 0 && excludedPath(path2)) {
          const baseline = baselines.get(path2);
          if (baseline != null && splitFile(baseline.text).body === splitFile(String(content4)).body) continue;
        }
        if (previous3.get(path2)?.equals(Buffer.from(content4)) !== true) {
          changes.set(path2, content4);
          result.changed.push(path2);
        }
      }
      for (const [hash, url] of candidate.assets.uploads) uploads.set(hash, url);
    }
    const through = result.leftOut.length > 0 || held.size > 0 ? cursor : [...listed.values()].map(normalizedTime).sort().at(-1) ?? cursor;
    const trailers = [...through === null ? [] : [captureCursorTrailer(through)], ...[...held].sort().map((id) => `Removal-held: ${id}`)];
    const message = trailers.length === 0 ? "Capture document ids" : `Capture document ids

${trailers.join("\n")}`;
    const uploadsCommit = await commitUploads(git, state.uploads, uploads, identity, state.uploads === null ? { message: UPLOADS_REBUILDING, always: true } : {});
    const prepared = await prepareLfs(git, fetched.tracked, changes);
    const linearCommit = await commitTree(git, { parents: [base], base, changes: prepared.changes, message: "Capture Linear changes", identity });
    const recordsChange = linearCommit !== base || uploadsCommit !== state.uploads;
    const always = held.size > 0 || heldBefore.size > 0 || through !== cursor && recordsChange;
    const idsCommit = await commitIds(git, state.ids, ids, identity, { message, always, reserved });
    if (prepared.oids.length > 0) await git.run(["lfs", "push", "--object-id", options.config.remote, ...prepared.oids]);
    const next = { linear: linearCommit, ids: idsCommit, uploads: uploadsCommit };
    const pushed = await pushAtomic(git, options.config, ["linear", "ids", "uploads"].map((store) => ({ ref: stateRef(options.config, store), expected: state[store], next: next[store] })));
    if (!pushed.ok) {
      result.ok = false;
      result.code = "state-moved";
    } else {
      result.state = next;
      published = true;
      for (const candidate of candidates.values()) {
        const refusal = lengthRefusal({ content: candidate.doc.content ?? "" }, linear.facts);
        if (refusal !== void 0) result.writeBackWarnings.push({ path: candidate.path, code: "linear-content-too-large-to-write-back", length: refusal.length, limit: refusal.limit });
      }
      const lostLease = new Error("state moved while recording document marks");
      const marked = [
        ...[...candidates.values()].filter(({ doc }) => !unmarked.has(doc.id)).map(({ doc, path: path2 }) => ({ doc, path: path2, blocked: [] })),
        ...result.blocked.map(({ id, path: path2, findings }) => ({ doc: documents.get(id), path: path2, blocked: findings }))
      ];
      try {
        for (const { doc, path: path2, blocked } of marked) {
          await reconcileDocumentMark({
            document: doc,
            entry: ids.get(path2),
            linear,
            blocked,
            persistEntry: async (entry) => {
              ids.set(path2, entry);
              const tip = await commitIds(git, result.state.ids, ids, identity, { reserved, message: "Capture document marks" });
              const updated = { ...next, ids: tip };
              const saved = await pushAtomic(git, options.config, ["linear", "ids", "uploads"].map((store) => ({ ref: stateRef(options.config, store), expected: result.state[store], next: updated[store] })));
              if (!saved.ok) {
                result.ok = false;
                result.code = "state-moved";
                throw lostLease;
              }
              result.state = updated;
            }
          });
        }
      } catch (error) {
        if (error !== lostLease) throw error;
      }
    }
    result.summary = renderCapture(result, gate.configured);
    return result;
  } catch (error) {
    if (!(error instanceof LinearStoppedError) && !(error instanceof LinearError && isTransientLinearError(error))) throw error;
    result.ok = false;
    if (error instanceof LinearStoppedError) {
      result.code = "stopped";
      result.stopped = error.reason;
    } else {
      result.code = "linear-failed";
      result.failure = { operation: error.operation, error: describeLinearError(error) };
    }
    if (!published) {
      result.changed = [];
      result.removed = [];
      result.heldRemovals = [];
    }
    result.summary = renderCapture(result, gate.configured);
    return result;
  } finally {
    await gate.close?.();
  }
}
var LINK_VARIANT_TARGETS = 4;
function linkVariants(candidates, textOf, reset, documentIds) {
  const variants = [];
  const without = (rejected) => {
    const targets = new Map(documentIds);
    for (const id of rejected) reset(id, targets);
    return targets;
  };
  for (const [id, candidate] of candidates) {
    const accepted = candidate.files.get(candidate.path);
    const linked = [...candidates.keys()].filter((other) => other !== id && textOf(candidate, without([other])) !== accepted);
    const combinations = linked.length <= LINK_VARIANT_TARGETS ? Array.from({ length: 2 ** linked.length - 1 }, (_, mask) => linked.filter((_2, bit) => mask + 1 >> bit & 1)) : [...linked.map((other) => [other]), linked];
    const texts = new Set(combinations.map((rejected) => textOf(candidate, without(rejected))));
    texts.delete(accepted);
    for (const text4 of texts) variants.push(new Map([...candidate.files, [candidate.path, text4]]));
  }
  return variants;
}
function relocatedHead(head) {
  const front = findFrontMatter(head);
  if (front === null) return head;
  const document4 = (0, import_yaml2.parseDocument)(front.yaml, { logLevel: "error", prettyErrors: false });
  const metadata = document4.toJS();
  delete metadata[TEAM_KEY];
  delete metadata[PROJECT_KEY];
  document4.delete(TEAM_KEY);
  document4.delete(PROJECT_KEY);
  if ((0, import_yaml2.isMap)(document4.contents) && document4.contents.items.length === 0) return "";
  let yaml;
  try {
    yaml = document4.toString();
  } catch {
    yaml = (0, import_yaml2.stringify)(metadata);
  }
  return `---
${yaml}---

`;
}
function placeKeyOf(place) {
  return place.projectId != null ? `project:${place.projectId}` : `team:${place.teamId}`;
}
function renderCapture(result, configured) {
  let summary2 = `Captured ${result.changed.length} files; removed ${result.removed.length}; blocked ${result.blocked.length}; left out ${result.leftOut.length}.`;
  if (result.heldRemovals.length > 0) {
    summary2 += `
Removal held for ${result.heldRemovals.length} files: Linear did not return their documents while their place listed no document, as a blank answer would read. The files stay; the next run removes them if Linear still does not have them: ${result.heldRemovals.map((path2) => JSON.stringify(path2)).join(", ")}.`;
  }
  if (result.rebuiltIds !== void 0) {
    summary2 += `
The document id map was lost: rebuilt by matching titles to paths, ${result.rebuiltIds.matched} of ${result.rebuiltIds.files} files matched. A document renamed in Linear since the last run comes back as a new file next to its old one.`;
  }
  if (result.stopped !== void 0) summary2 += `
Capture partial, will continue.

${renderStop(result.stopped).join("\n")}`;
  if (result.failure !== void 0) summary2 += `
Capture partial, will continue: Linear failed ${result.failure.operation} (${result.failure.error}).`;
  if (!configured) summary2 += "\nContent is pushed unchecked: no security hooks are configured.";
  for (const warning of result.writeBackWarnings) {
    summary2 += `
${warning.code}: ${JSON.stringify(warning.path)} (${warning.length} characters; limit ${warning.limit}). Preserved in git; Linear will not accept it back if it is changed in git while still over the limit.`;
  }
  return summary2;
}
async function prepareLfs(git, tracked, changes) {
  const dir = await mkdtemp4(join7(tmpdir4(), "capture-attributes-"));
  const env = { GIT_INDEX_FILE: join7(dir, "index") };
  const result = new Map(changes);
  const oids = [];
  try {
    await git.run(["read-tree", tracked], { env });
    for (const [path2, content4] of changes) {
      if (content4 === null) continue;
      const attributes = await git.run(["check-attr", "--cached", "-z", "--stdin", "filter"], { input: `${path2}\0`, env });
      if (attributes.stdout.toString("utf8").split("\0")[2] !== "lfs") continue;
      const cleaned = await git.run(["lfs", "clean", "--", path2], { input: content4 });
      const hash = /\noid sha256:([a-f0-9]{64})\n/.exec(cleaned.stdout.toString("utf8"))?.[1];
      if (hash === void 0) throw new Error("LFS did not return a pointer");
      oids.push(hash);
      result.set(path2, cleaned.stdout);
    }
    return { changes: result, oids: [...new Set(oids)] };
  } finally {
    await rm4(dir, { recursive: true, force: true });
  }
}

// src/sync/pull-request.ts
var DEFAULT_MERGE_GRACE_SECONDS = 60;
var SYNC_PULL_REQUEST_TITLE = "Changes from Linear";
var SYNC_BRANCH_MERGE_MESSAGE = "Merge Linear's latest changes";
var TRACKED_MERGE_MESSAGE = "Merge the tracked branch into the sync branch";
var LISTED_PATHS = 200;
function pullRequestFailure(result) {
  switch (result?.code) {
    case "check-failed":
      return { kind: "setup", code: result.code, message: `setup error (${result.code}): a check failed on the sync pull request` };
    case "merge-blocked":
      return { kind: "setup", code: result.code, message: `setup error (${result.code}): GitHub refuses again to merge the sync pull request (${refusalText(result)})` };
    case "initial-pull-request-pending":
      return { kind: "no-state", code: result.code, message: `stopped short (${result.code}): an initial sync from Linear waits for a person to merge it` };
    case "state-moved":
    case "github-failed":
      return { kind: "incomplete", code: result.code, message: `not finished (${result.code}); run it again` };
    default:
      return null;
  }
}
async function syncPullRequest(context, options) {
  const { git, fetched } = context;
  const { config, github } = options;
  const tracked = fetched.tracked;
  const sync = fetched.sync;
  const linear = options.state.linear;
  const result = { needed: false, pullRequest: null, branchMoved: false, checks: null, merged: null, paths: [], marked: [], decided: [] };
  if (linear === null) return result;
  const trackedTree = await git.text(["rev-parse", `${tracked}^{tree}`]);
  const wanted = await mergedTree(git, tracked, linear);
  if (wanted === null) return { ...result, needed: true, code: "conflict" };
  result.needed = wanted !== trackedTree;
  const pending = sync !== null && !await isAncestor2(git, sync, tracked);
  if (!result.needed && !pending) {
    if (sync !== null || await isAncestor2(git, linear, tracked) || await isInitialRecord(git, linear)) return result;
    const pushed = await pushAtomic(git, config, [{ ref: branchRef(config.syncBranch), expected: null, next: linear }]);
    if (pushed.ok) return { ...result, branchMoved: true };
    return pushed.reason === "stale" ? { ...result, code: "state-moved" } : result;
  }
  try {
    const open = sync === null ? null : await findOpenPullRequest(github, config.syncBranch, config.trackedBranch);
    if (open !== null && pending && await holdsInitialRecord(git, sync, tracked)) return { ...result, code: "initial-pull-request-pending" };
    const identity = options.identity ?? SYNC_IDENTITY;
    const merger = markedMerger(git, options.state.ids, identity);
    const resolved = { marked: [], decided: [] };
    let head = sync;
    if (open === null && (!pending || await holdsInitialRecord(git, sync, tracked))) {
      if (!result.needed) return result;
      head = await restart(git, sync, linear, wanted, identity);
    } else {
      const advanced = await advance(git, merger, sync, linear);
      if (advanced === null) return { ...result, code: "conflict" };
      if (advanced.head !== sync) {
        const now = await mergedTree(git, tracked, sync);
        const next = await mergedTree(git, tracked, advanced.head);
        if (next === null || next !== now) {
          head = advanced.head;
          addResolution(resolved, advanced);
        }
      }
    }
    if (head === null) return { ...result, code: "conflict" };
    let headTree = await mergedTree(git, tracked, head);
    if (headTree === null) {
      const merged = await merger(head, tracked, [head, tracked], TRACKED_MERGE_MESSAGE);
      if (merged === null) return { ...result, code: "conflict" };
      head = merged.head;
      addResolution(resolved, merged);
      headTree = await git.text(["rev-parse", `${head}^{tree}`]);
    }
    if (open === null && !result.needed && headTree === trackedTree) return result;
    if (head !== sync) {
      const pushed = await pushAtomic(git, config, [{ ref: branchRef(config.syncBranch), expected: sync, next: head }]);
      if (!pushed.ok) return { ...result, code: "state-moved" };
      result.branchMoved = true;
      result.marked = [...new Set(resolved.marked)].sort();
      result.decided = [...new Set(resolved.decided)].sort();
    }
    result.paths = (await git.text(["diff", "--name-only", "--no-renames", trackedTree, headTree])).split("\n").filter(Boolean);
    const noted = open === null ? null : readRefusal(open.body);
    const earlier = noted !== null && noted.head === head && noted.base === tracked ? noted : null;
    const { pullRequest, opened } = await ensurePullRequest(github, {
      head: config.syncBranch,
      base: config.trackedBranch,
      title: SYNC_PULL_REQUEST_TITLE,
      body: pullRequestBody2(result.paths, earlier)
    });
    result.pullRequest = { number: pullRequest.number, url: pullRequest.url, opened };
    const fresh = result.branchMoved || opened;
    const grace = options.mergeGraceSeconds ?? DEFAULT_MERGE_GRACE_SECONDS;
    if (fresh && grace === 0) return result;
    result.checks = fresh ? await waitForChecks(github, head, grace) : await readChecks(github, head);
    if (result.checks.state === "failed") return { ...result, code: "check-failed" };
    if (result.checks.state === "pending") return result;
    const merge = await mergePullRequest(github, pullRequest.number, head);
    if (!merge.merged) {
      const refusal = { head, base: tracked, status: merge.status, reason: merge.reason };
      const refused = { ...result, status: merge.status, reason: merge.reason };
      if (earlier !== null && earlier.status === refusal.status && earlier.reason === refusal.reason) return { ...refused, code: "merge-blocked" };
      try {
        await updatePullRequest(github, pullRequest.number, { title: SYNC_PULL_REQUEST_TITLE, body: pullRequestBody2(result.paths, refusal) });
      } catch (error) {
        if (!(error instanceof PullRequestError)) throw error;
      }
      return { ...refused, code: "merge-refused" };
    }
    result.merged = merge.sha;
    result.pullRequest = null;
    return result;
  } catch (error) {
    if (error instanceof PullRequestError) return { ...result, code: "github-failed", ...error.status === void 0 ? {} : { status: error.status } };
    throw error;
  }
}
async function isInitialRecord(git, commit) {
  const [subject] = (await git.text(["show", "-s", "--format=%s", commit])).split("\n");
  return subject === RECORD_MESSAGE || subject === INITIAL_SYNC_FROM_LINEAR_RECORD;
}
async function holdsInitialRecord(git, sync, tracked) {
  const commits = (await git.text(["log", "--first-parent", "--format=%H %s", `${tracked}..${sync}`])).split("\n");
  let record;
  for (const line2 of commits) {
    const separator = line2.indexOf(" ");
    const subject = line2.slice(separator + 1);
    if (subject === SYNC_BRANCH_MERGE_MESSAGE) break;
    if (subject === INITIAL_SYNC_FROM_LINEAR_RECORD) {
      record = line2.slice(0, separator);
      break;
    }
  }
  if (record === void 0) return false;
  return initialRecordChangesParent(git, record);
}
async function mergedTree(git, into, from) {
  const merged = await git.run(["merge-tree", "--write-tree", "--no-messages", into, from], { okCodes: [0, 1] });
  if (merged.code !== 0) return null;
  return merged.stdout.toString("utf8").split("\n")[0];
}
async function isAncestor2(git, ancestor, descendant) {
  return (await git.run(["merge-base", "--is-ancestor", ancestor, descendant], { okCodes: [0, 1] })).code === 0;
}
async function restart(git, sync, linear, wanted, identity) {
  if (sync === null || await isAncestor2(git, sync, linear)) return linear;
  return commitMerge(git, wanted, [sync, linear], SYNC_BRANCH_MERGE_MESSAGE, identity);
}
function addResolution(into, from) {
  into.marked.push(...from.marked);
  into.decided.push(...from.decided);
}
function markedMerger(git, idsCommit, identity) {
  let lookup;
  const idsOnce = () => lookup ??= readIds(git, idsCommit).then((ids) => ({ ids, knownId: knownIdLookup(git, idsCommit, ids) }));
  return async (linearSide, gitSide, parents, message) => {
    const clean = await mergedTree(git, linearSide, gitSide);
    if (clean !== null) return { head: await commitMerge(git, clean, parents, message, identity), marked: [], decided: [] };
    const { ids, knownId } = await idsOnce();
    const { resolved } = await mergeWithMarkers(git, linearSide, gitSide, ids, knownId);
    if (resolved.unresolved.length > 0) return null;
    return { head: await commitMerge(git, resolved.tree, parents, message, identity), marked: resolved.marked, decided: resolved.decided.map((entry) => entry.path) };
  };
}
async function advance(git, merge, sync, linear) {
  if (await isAncestor2(git, sync, linear)) return { head: linear, marked: [], decided: [] };
  if (await isAncestor2(git, linear, sync)) return { head: sync, marked: [], decided: [] };
  return merge(linear, sync, [sync, linear], SYNC_BRANCH_MERGE_MESSAGE);
}
function commitMerge(git, tree, parents, message, identity) {
  return git.text(["commit-tree", "--no-gpg-sign", tree, "-p", parents[0], "-p", parents[1], "-m", message], {
    env: { GIT_AUTHOR_NAME: identity.name, GIT_AUTHOR_EMAIL: identity.email, GIT_COMMITTER_NAME: identity.name, GIT_COMMITTER_EMAIL: identity.email }
  });
}
function pullRequestBody2(paths, refusal) {
  const lines2 = [
    "Changes made in Linear, on their way to this branch.",
    "",
    "The sync merges this pull request with a merge commit once every check on its head has finished and passed, and adds later Linear changes to it until then.",
    "",
    `Files changed: ${paths.length}.`
  ];
  if (paths.length > 0) lines2.push("", ...paths.slice(0, LISTED_PATHS).map((path2) => `- ${path2}`));
  if (paths.length > LISTED_PATHS) lines2.push(`- and ${paths.length - LISTED_PATHS} more`);
  if (refusal !== null) {
    lines2.push(
      "",
      `GitHub refused to merge head \`${refusal.head.slice(0, 12)}\` (${refusalText(refusal)}). If it refuses this head again for the same reason, the sync reports a setup error.`,
      `<!-- merge refused: head=${refusal.head} base=${refusal.base} status=${refusal.status} reason=${encodeURIComponent(refusal.reason)} -->`
    );
  }
  return `${lines2.join("\n")}
`;
}
var REFUSAL_NOTE = /^<!-- merge refused: head=([0-9a-f]+) base=([0-9a-f]+) status=(\d+) reason=([^\s]*) -->\r?$/m;
function readRefusal(body2) {
  const note = REFUSAL_NOTE.exec(body2);
  if (note === null) return null;
  let reason;
  try {
    reason = decodeURIComponent(note[4]);
  } catch {
    return null;
  }
  return { head: note[1], base: note[2], status: Number(note[3]), reason };
}
function refusalText(refusal) {
  const reason = refusal.reason?.replace(/[`\r\n]/g, " ");
  return `HTTP ${refusal.status ?? 0}${reason ? `: \`${reason}\`` : ""}`;
}
function renderPullRequest(result) {
  const lines2 = ["### Linear to the tracked branch", ""];
  const pr = result.pullRequest;
  const link = pr === null ? "" : `[#${pr.number}](${pr.url})`;
  const names = (list2) => (list2 ?? []).map((name) => `\`${name}\``).join(", ");
  switch (result.code) {
    case "check-failed":
      lines2.push(
        `Setup error: ${result.checks?.failed.length === 1 ? "a check" : "checks"} failed on the sync pull request ${link}: ${names(result.checks?.failed)}.`,
        "The sync does not merge it and writes no tracked-branch changes to Linear until the checks pass. Checks on the sync pull request must pass Linear's form: fix the repository's configuration or rerun the failed check, and a later run merges once they pass."
      );
      break;
    case "conflict":
      lines2.push("Linear's latest changes and the tracked branch, or the sync pull request's branch, change the same lines. The sync branch is left as it is this run. When the conflicting files are documents, the sync merges them with conflict markers: this run into Linear's state, a later run into the sync branch. A conflicting file that is not a document waits: merge the tracked branch and Linear's state ref into the sync branch and resolve it there; the sync keeps those commits.");
      break;
    case "merge-refused":
      lines2.push(`GitHub did not merge the sync pull request ${link} (${refusalText(result)}); a later run tries again.`);
      break;
    case "merge-blocked":
      lines2.push(
        `Setup error: GitHub refused again to merge the sync pull request ${link}, on the same head and for the same reason as an earlier run (${refusalText(result)}).`,
        "Nothing changes until a person does: let the sync's GitHub App merge into the tracked branch (for example, adjust the branch's rules), and a later run merges."
      );
      break;
    case "initial-pull-request-pending":
      lines2.push("The sync branch holds an initial sync from Linear that a person has not merged yet. The sync adds nothing to it and writes nothing to Linear until it is merged.");
      break;
    case "state-moved":
      lines2.push("The sync branch moved while this run worked; the next run updates the sync pull request.");
      break;
    case "github-failed":
      lines2.push(
        result.status === void 0 ? "A request to GitHub for the sync pull request got no answer (the connection broke or timed out); the next run tries again." : `GitHub refused or failed a request for the sync pull request (HTTP ${result.status}); the next run tries again.`
      );
      break;
    default:
      if (result.merged !== null) lines2.push("Merged the sync pull request with a merge commit: every check on its head passed.");
      else if (pr === null) lines2.push("The tracked branch already holds every change from Linear: no pull request is needed.");
      else if (pr.opened) lines2.push(`Opened the sync pull request ${link}. ${result.checks?.pending.length ? `Waiting for ${names(result.checks.pending)}; a later run merges it.` : "A later run merges it when every check on its head has passed."}`);
      else if (result.branchMoved) lines2.push(`Added new Linear changes to the sync pull request ${link}. ${result.checks?.pending.length ? `Waiting for ${names(result.checks.pending)}; a later run merges it.` : "A later run merges it when every check on its head has passed."}`);
      else lines2.push(`The sync pull request ${link} waits for ${names(result.checks?.pending) || "its checks"}; a later run merges it.`);
  }
  if (result.paths.length > 0) lines2.push("", `Files it changes on the tracked branch: ${result.paths.length}.`);
  if (result.marked.length > 0) {
    lines2.push(
      "",
      `Pending edits on the sync branch and later edits change the same lines in ${result.marked.length === 1 ? "1 document" : `${result.marked.length} documents`}: ${names(result.marked)}. Both versions are kept between conflict markers; edit the text on either side to resolve it.`
    );
  }
  if (result.decided.length > 0) {
    lines2.push(
      "",
      `Pending deletes or renames on the sync branch met later edits or renames in ${result.decided.length === 1 ? "1 document" : `${result.decided.length} documents`}: ${names(result.decided)}. The sync decided them by its structural conflict rules, as for any other conflict: an edited document is kept.`
    );
  }
  lines2.push("");
  return lines2;
}

// src/sync/write.ts
import { createHash as createHash8, randomUUID as randomUUID3 } from "node:crypto";
var MERGE_RECORD_MESSAGE = "Sync: Linear's state after taking in the tracked branch";
var PARTIAL_RECORD_MESSAGE = "Sync: Linear's state, part of the tracked branch taken in";
var IDS_MESSAGE = "Sync: document ids";
var REREAD_BATCH = 50;
var StopWriting = class extends Error {
};
var StateMovedError2 = class extends Error {
};
async function writeTrackedToLinear(context, options) {
  const { git, fetched, targets, linear } = context;
  const transforms = options.transforms?.() ?? [];
  const tipTransforms = options.transforms?.() ?? [];
  const identity = options.identity ?? SYNC_IDENTITY;
  const rereadBatch = Math.max(1, options.rereadBatch ?? REREAD_BATCH);
  const stopAfter = "stopAfterDocuments" in options ? options.stopAfterDocuments : testStopAfterDocuments();
  const checkpoint2 = options.checkpoint ?? ((name) => checkpoint(name));
  const newId = options.newId ?? randomUUID3;
  const expected = { ...options.state };
  const tracked = fetched.tracked;
  const linearTip = expected.linear;
  if (linearTip === null) throw new Error("the sync writes to Linear only after initial sync has recorded `linear`");
  const result = {
    complete: false,
    changed: false,
    resumed: await wentOnFromPartial(git, [context.fetched.state.linear, linearTip]),
    updated: [],
    relocated: [],
    created: [],
    trashed: [],
    adopted: [],
    restored: [],
    conflicts: [],
    decided: [],
    skipped: [],
    leftOut: [],
    leftOutAtWrite: [],
    failed: [],
    notAttempted: [],
    rereadWindowMs: null,
    record: null,
    state: { ...expected }
  };
  const readContainers = async () => {
    try {
      return await readContainerDocuments(context);
    } catch (error) {
      if (!(error instanceof LinearError)) throw error;
      result.notAttempted = context.mapping.documents.map((document4) => document4.path).sort();
      if (error instanceof LinearStoppedError) {
        result.code = "stopped";
        result.stopped = error.reason;
      } else {
        result.code = "write-failed";
        result.failed = result.notAttempted.map((path2) => ({ path: path2, operation: error.operation, error: describeLinearError(error) }));
      }
      return void 0;
    }
  };
  const cacheLost = await uploadsRebuilding(git, expected.uploads);
  const nothingNew = await alreadyMerged(git, linearTip, tracked) || await mergedInitialRecord(git, linearTip, tracked);
  if (nothingNew && !cacheLost) {
    result.leftOut = await leftOutFiles(git, linearTip, linear.facts);
    const containers2 = options.containers ?? await readContainers();
    if (containers2 === void 0) return result;
    result.capacity = assessCapacity(context, containers2, [], options.documentCap);
    if (capacityBlocked(result.capacity)) {
      result.code = "container-cap";
      return result;
    }
    result.complete = true;
    return result;
  }
  const ids = await readIds(git, expected.ids);
  const reserved = await readReservedIds(git, expected.ids);
  const knownId = knownIdLookup(git, expected.ids, ids);
  const merge = await mergeLocally(git, linearTip, tracked, ids, linear.facts, { knownId, keptAnnotations: await readKeptAnnotations(git, expected.ids) });
  if (nothingNew) merge.changes.length = 0;
  result.leftOut = merge.leftOut;
  const containerListing = await readContainers();
  if (containerListing === void 0) return result;
  const containers = containerListing;
  await findGoneRestores();
  for (const path2 of merge.conflicts) if (merge.result.has(path2) || merge.linear.has(path2) || ids.has(path2)) result.skipped.push({ path: path2, reason: "conflict" });
  for (const entry of merge.held) result.skipped.push({ path: entry.from, reason: "renamed-to-unwritable" });
  await checkpoint2("after-local-merge-before-record");
  const uploads = await readUploads(git, expected.uploads);
  const resultFiles = await filesOf(git, merge.tree);
  const linearFiles = await filesOf(git, linearTip);
  const texts = merge.texts;
  const textOf = (file) => texts.get(file.oid).toString("utf8");
  const candidate = await git.text(["commit-tree", "--no-gpg-sign", merge.tree, "-p", linearTip, "-p", tracked, "-m", "merge result"], {
    env: { GIT_AUTHOR_NAME: identity.name, GIT_AUTHOR_EMAIL: identity.email, GIT_COMMITTER_NAME: identity.name, GIT_COMMITTER_EMAIL: identity.email }
  });
  const creates = merge.changes.filter((change) => change.kind === "create");
  const adoptable = await adoptableDocuments(creates.filter((change) => change.restore === void 0));
  const restoresInPlace = (change) => {
    if (change.restore === void 0 || change.restore.recreate !== void 0) return false;
    const destination2 = merge.result.get(change.path);
    return containers.get(containerKey(context, destination2.place))?.some((document4) => document4.id === change.restore?.id) === true;
  };
  const additions = creates.filter((change) => !adoptable.has(change.path) && !restoresInPlace(change)).map((change) => merge.result.get(change.path));
  for (const change of merge.changes) {
    if (change.kind !== "keep" || !change.place) continue;
    const destination2 = merge.result.get(change.to);
    const present = containers.get(containerKey(context, destination2.place))?.some((document4) => document4.id === change.id);
    if (!present) additions.push(destination2);
  }
  result.capacity = assessCapacity(context, containers, additions, options.documentCap);
  if (capacityBlocked(result.capacity)) {
    result.code = "container-cap";
    result.notAttempted = merge.changes.map(changePath);
    return result;
  }
  const taken = /* @__PURE__ */ new Set();
  const usingReserved = new Set(creates.filter((change) => !adoptable.has(change.path) && reserved.has(change.path)).map((change) => change.path));
  let unchecked;
  try {
    const listed = new Set([...containers.values()].flat().map((document4) => document4.id));
    const saved = [...new Set([...usingReserved].map((path2) => reserved.get(path2)))];
    for (const id of saved) if (listed.has(id)) taken.add(id);
    const unlisted = saved.filter((id) => !listed.has(id));
    if (unlisted.length > 0) for (const document4 of await linear.getDocuments(unlisted, { withContent: false })) taken.add(document4.id);
  } catch (error) {
    if (error instanceof LinearStoppedError) {
      result.stopped = error.reason;
      result.notAttempted = merge.changes.map(changePath);
      result.code = "stopped";
      return result;
    }
    if (!(error instanceof LinearError)) throw error;
    unchecked = error;
  }
  const documentIds = /* @__PURE__ */ new Map();
  for (const [path2, entry] of ids) documentIds.set(path2, entry.id);
  for (const change of merge.changes) if (change.kind === "keep") documentIds.set(change.to, change.id);
  for (const change of creates) {
    const saved = reserved.get(change.path);
    const restoreId = change.restore?.recreate ?? change.restore?.id;
    documentIds.set(change.path, restoreId ?? adoptable.get(change.path)?.id ?? (saved !== void 0 && !taken.has(saved) ? saved : newId()));
  }
  const stored = /* @__PURE__ */ new Map();
  const nextIds = new Map(ids);
  for (const change of merge.unchanged) {
    if (change.from === change.to) continue;
    nextIds.set(change.to, nextIds.get(change.from));
    nextIds.delete(change.from);
    documentIds.set(change.to, change.id);
  }
  const nextReserved = new Map([...reserved].filter(([path2]) => resultFiles.has(path2)));
  for (const change of creates) if (!adoptable.has(change.path)) nextReserved.set(change.path, documentIds.get(change.path));
  const notDone = [];
  const tipUploads = cacheLost ? /* @__PURE__ */ new Map() : new Map(uploads);
  let written = 0;
  let rereadAt = 0;
  const timed = async (write) => {
    const done = await write();
    const window = Math.round((performance.now() - rereadAt) * 10) / 10;
    result.rereadWindowMs = Math.max(result.rereadWindowMs ?? 0, window);
    return done;
  };
  try {
    const plan = transformPlan();
    for (const transform of transforms) await transform.prepare?.({ git, tracked: candidate, linear, plan, uploads, documentIds });
    for (const transform of tipTransforms) await transform.prepare?.({ git, tracked: linearTip, linear: withoutUploads(linear), plan: { create: [], overwrite: [], trash: [], leftOut: [] }, uploads: tipUploads, documentIds });
    await findLinkedFileChanges();
    const changes = merge.changes;
    const stopAt = (from, reason) => {
      result.stopped = reason;
      const rest = changes.slice(from);
      result.notAttempted = rest.map(changePath);
      notDone.push(...rest);
      throw new StopWriting();
    };
    if (changes.length > 0) await checkpoint2("before-write");
    for (let start2 = 0; start2 < changes.length; start2 += rereadBatch) {
      const batch = changes.slice(start2, start2 + rereadBatch);
      let current;
      try {
        current = await reread(batch);
        rereadAt = performance.now();
      } catch (error) {
        if (error instanceof LinearStoppedError) stopAt(start2, error.reason);
        if (!(error instanceof LinearError)) throw error;
        for (const change of batch) result.failed.push({ path: changePath(change), operation: error.operation, error: describeLinearError(error) });
        notDone.push(...batch);
        continue;
      }
      await checkpoint2("after-reread-before-write");
      for (let index2 = 0; index2 < batch.length; index2 += 1) {
        const change = batch[index2];
        const stop = linear.stopped ?? (stopAfter !== void 0 && written >= stopAfter ? { kind: "test-threshold", documents: stopAfter } : void 0);
        if (stop !== void 0) stopAt(start2 + index2, stop);
        const path2 = changePath(change);
        if (change.kind === "create" && unchecked !== void 0 && usingReserved.has(path2)) {
          result.failed.push({ path: path2, operation: unchecked.operation, error: describeLinearError(unchecked) });
          notDone.push(change);
          continue;
        }
        try {
          const done = await apply(change, current);
          if (done) written += 1;
          else notDone.push(change);
        } catch (error) {
          if (error instanceof LeaveOutError) {
            result.leftOutAtWrite.push(error.files.length > 0 ? { path: path2, rule: error.rule, files: [...error.files] } : { path: path2, rule: error.rule });
            notDone.push(change);
            continue;
          }
          if (error instanceof LinearStoppedError) stopAt(start2 + index2, error.reason);
          if (error instanceof LinearError) {
            result.failed.push({ path: path2, operation: error.operation, error: describeLinearError(error) });
            notDone.push(change);
            continue;
          }
          throw error;
        }
      }
    }
  } catch (error) {
    if (error instanceof StateMovedError2) {
      result.code = "state-moved";
      return result;
    }
    if (error instanceof LinearStoppedError) {
      result.stopped = error.reason;
      result.notAttempted = merge.changes.map(changePath);
      notDone.splice(0, notDone.length, ...merge.changes);
    } else if (!(error instanceof StopWriting)) throw error;
  }
  if (written > 0) result.changed = true;
  const undone = /* @__PURE__ */ new Set([
    ...notDone.flatMap(pathsOf),
    ...result.notAttempted,
    ...result.skipped.map((entry) => entry.path),
    ...result.failed.map((entry) => entry.path),
    ...result.leftOutAtWrite.map((entry) => entry.path)
  ]);
  result.conflicts = merge.marked.filter((path2) => !undone.has(path2));
  result.decided = merge.decided.filter((entry) => !undone.has(entry.path));
  await checkpoint2("after-write-before-record");
  const allDone = notDone.length === 0 && merge.conflicts.length === 0 && merge.held.length === 0;
  const recorded = await record(allDone);
  if (recorded === null) {
    result.code = "state-moved";
    return result;
  }
  if (result.stopped !== void 0) result.code = "stopped";
  else if (result.failed.length > 0) result.code = "write-failed";
  result.complete = allDone;
  return result;
  async function findLinkedFileChanges() {
    if (transforms.length === 0) return;
    const changedNames = /* @__PURE__ */ new Set();
    for (const path2 of /* @__PURE__ */ new Set([...linearFiles.keys(), ...resultFiles.keys()])) {
      if (!path2.endsWith(".md") && linearFiles.get(path2) !== resultFiles.get(path2)) changedNames.add(path2.slice(path2.lastIndexOf("/") + 1));
    }
    const sameText = [...merge.unchanged, ...merge.changes.filter((change) => change.kind === "keep" && !change.content)];
    const relinked = [];
    if (!cacheLost && changedNames.size === 0 && !sameText.some((change) => change.from !== change.to)) return;
    const comparisonTransforms = options.transforms?.() ?? [];
    for (const transform of comparisonTransforms) await transform.prepare?.({ git, tracked: candidate, linear: withoutUploads(linear), plan: { create: [], overwrite: [], trash: [], leftOut: [] }, uploads, documentIds });
    for (const change of sameText) {
      const next = merge.result.get(change.to);
      const previous3 = merge.linear.get(change.from);
      const text4 = textOf(next);
      const moved = change.from !== change.to;
      if (!moved && !cacheLost && ![...changedNames].some((name) => text4.includes(name) || text4.includes(encodeURI(name)) || text4.includes(encodeURIComponent(name)))) continue;
      let differs;
      try {
        const written2 = await transformBody(comparisonTransforms, change.to, splitFile(text4).body);
        if (cacheLost && !moved) {
          const links = await transformBody(tipTransforms, change.from, splitFile(textOf(previous3)).body).then(() => false, (error) => error instanceof UploadRefusedError);
          if (links) relinked.push({ change, written: written2 });
          continue;
        }
        differs = written2 !== await transformBody(tipTransforms, change.from, splitFile(textOf(previous3)).body);
      } catch (error) {
        if (!(error instanceof LeaveOutError) && !(error instanceof LinearStoppedError) && !(error instanceof UploadRefusedError)) throw error;
        differs = true;
      }
      if (differs) markContent(change);
    }
    if (relinked.length > 0) {
      let held;
      try {
        held = new Map((await linear.getDocuments(relinked.map(({ change }) => change.id), { withContent: true })).map((document4) => [document4.id, document4.content]));
      } catch (error) {
        if (!(error instanceof LinearError) || error instanceof LinearStoppedError) throw error;
      }
      for (const { change, written: written2 } of relinked) if (held?.get(change.id) !== written2) markContent(change);
    }
    merge.changes.sort((a, b) => compare9(changePath(a), changePath(b)));
    function markContent(change) {
      if (merge.changes.includes(change)) change.content = true;
      else merge.changes.push({ ...change, content: true });
    }
  }
  async function adoptableDocuments(changes) {
    const found = /* @__PURE__ */ new Map();
    if (changes.length === 0) return found;
    const mapped = new Set([...ids.values()].map((entry) => entry.id));
    const byPlace = /* @__PURE__ */ new Map();
    for (const change of changes) {
      const file = merge.result.get(change.path);
      const key = containerKey(context, file.place);
      const group = byPlace.get(key) ?? { place: file.place, paths: [] };
      group.paths.push(change.path);
      byPlace.set(key, group);
    }
    for (const { place, paths } of byPlace.values()) {
      const listed = (containers.get(containerKey(context, place)) ?? []).filter((document4) => !document4.trashed && document4.archivedAt === null);
      const oldestFirst = [...listed].sort((a, b) => compare9(a.createdAt, b.createdAt) || compare9(a.id, b.id));
      for (const path2 of paths) {
        const title = merge.result.get(path2).title.normalize("NFC");
        const fits = (candidate2) => !mapped.has(candidate2.id) && candidate2.title.normalize("NFC") === title;
        const document4 = oldestFirst.find((candidate2) => candidate2.id === reserved.get(path2) && fits(candidate2)) ?? oldestFirst.find(fits);
        if (document4 !== void 0) {
          mapped.add(document4.id);
          found.set(path2, document4);
        }
      }
    }
    return found;
  }
  async function reread(batch) {
    const wanted = batch.flatMap((change) => change.kind === "create" ? [] : [change.id]);
    for (const change of batch) if (change.kind === "create" && adoptable.has(change.path)) wanted.push(adoptable.get(change.path).id);
    for (const change of batch) if (change.kind === "create" && change.restore !== void 0) wanted.push(change.restore.recreate ?? change.restore.id);
    const documents = wanted.length === 0 ? [] : await linear.getDocuments(wanted, { withContent: true });
    return new Map(documents.map((document4) => [document4.id, document4]));
  }
  async function unchangedSinceCapture(document4, path2) {
    if (document4.trashed || document4.archivedAt !== null) return false;
    const synchronized = merge.linear.get(path2);
    if (synchronized !== void 0) return holdsVersion(document4, synchronized, textOf(synchronized), tipTransforms, true);
    const baseline = await lastSynchronized(git, linearTip, path2, linear.facts);
    if (baseline === null) return false;
    const baselineTransforms = options.transforms?.() ?? [];
    const plan = { create: [], overwrite: [], trash: [], leftOut: [] };
    for (const transform of baselineTransforms) {
      await transform.prepare?.({ git, tracked: baseline.commit, linear: withoutUploads(linear), plan, uploads: tipUploads, documentIds });
    }
    return holdsVersion(document4, baseline.file, baseline.text, baselineTransforms, false);
  }
  async function holdsVersion(document4, file, text4, through, uncheckable) {
    const folder = file.path.slice(0, -(file.title.length + ".md".length)).replace(/\/$/, "");
    const occupied = new Set([...linearFiles.keys()].filter((path2) => path2 !== file.path));
    if (document4.title.normalize("NFC") !== file.title.normalize("NFC") && documentPath(folder, document4.title, document4.id, occupied, file.path) !== file.path) return false;
    if (resolves(file.place) && !inPlace(document4, file.place)) return false;
    let expected2;
    try {
      expected2 = await transformBody(through, file.path, splitFile(text4).body);
    } catch (error) {
      if (!(error instanceof LeaveOutError) && !(error instanceof UploadRefusedError)) throw error;
      return uncheckable;
    }
    return sameMarkdown(document4.content ?? "", expected2);
  }
  function resolves(place) {
    return place.kind === "project" ? targets.projects.has(projectKey(place.team, place.project)) : targets.teams.has(place.team);
  }
  function inPlace(document4, place) {
    const where = placeId(targets, place);
    return "projectId" in where ? document4.projectId === where.projectId : document4.projectId === null && document4.teamId === where.teamId;
  }
  async function apply(change, current) {
    if (change.kind === "trash") return trash(change, current);
    if (change.kind === "keep") return keep(change, current);
    return create(change, current);
  }
  async function trash(change, current) {
    const document4 = current.get(change.id);
    if (document4 === void 0 || document4.trashed || document4.archivedAt !== null) {
      nextIds.delete(change.path);
      result.trashed.push(change.path);
      return true;
    }
    if (!await unchangedSinceCapture(document4, change.path)) return skip(change.path, "edited-in-linear");
    await timed(() => linear.trashDocument(change.id));
    nextIds.delete(change.path);
    result.trashed.push(change.path);
    return true;
  }
  async function keep(change, current) {
    const document4 = current.get(change.id);
    if (document4 === void 0 || document4.trashed || document4.archivedAt !== null) return skip(change.to, "missing-in-linear");
    const file = merge.result.get(change.to);
    const patch = {};
    let readBack;
    if (change.content) patch.content = await transformBody(transforms, change.to, splitFile(textOf(file)).body);
    if (change.title) patch.title = file.title.normalize("NFC");
    if (change.place) Object.assign(patch, placePatch(file.place));
    const holds = (patch.content === void 0 || document4.content != null && sameMarkdown(document4.content, patch.content)) && (patch.title === void 0 || document4.title.normalize("NFC") === patch.title) && (!change.place || inPlace(document4, file.place));
    if (holds) {
      if (patch.content !== void 0) {
        stored.set(change.to, { content: document4.content ?? "", sent: patch.content, document: document4 });
        readBack = document4;
      }
    } else {
      if (!await unchangedSinceCapture(document4, change.from)) return skip(change.to, "edited-in-linear");
      const updated = await timed(() => linear.updateDocument(change.id, patch));
      if (patch.content !== void 0) {
        stored.set(change.to, { content: updated.content ?? "", sent: patch.content, document: updated });
        readBack = updated;
      }
    }
    if (change.comment !== void 0 && document4.documentContentId !== null) {
      await linear.ensureDocumentComment(document4.documentContentId, change.comment, stableId("retitled", change.id, merge.base));
    }
    const entry = nextIds.get(change.from);
    nextIds.delete(change.from);
    nextIds.set(change.to, entry !== void 0 && entry.id === change.id ? entry : { id: change.id });
    if (readBack !== void 0) await reconcileMark(change.to, readBack);
    if (change.content) result.updated.push(change.to);
    if (change.from !== change.to || change.title || change.place) result.relocated.push({ from: change.from, to: change.to });
    return true;
  }
  async function create(change, current) {
    const file = merge.result.get(change.path);
    const body2 = await transformBody(transforms, change.path, splitFile(textOf(file)).body);
    const id = documentIds.get(change.path);
    if (change.restore !== void 0 && change.restore.recreate === void 0) return restore(change, file, body2, current);
    const recreated = change.restore?.recreate === void 0 ? void 0 : current.get(change.restore.recreate);
    const adopted = adoptable.get(change.path) ?? recreated;
    let document4;
    if (adopted !== void 0) {
      const live = current.get(adopted.id);
      const write = () => linear.updateDocument(adopted.id, { content: body2 });
      document4 = live === void 0 ? await write() : live.content != null && sameMarkdown(live.content, body2) ? live : await timed(write);
      if (recreated === void 0) result.adopted.push(change.path);
    } else {
      document4 = await linear.createDocument(placeId(targets, file.place), { id, title: file.title.normalize("NFC"), content: body2 });
      await checkpoint2("document-created-before-ids-push");
    }
    stored.set(change.path, { content: document4.content ?? "", sent: body2, document: document4 });
    nextIds.set(change.path, { id: document4.id });
    result.created.push(change.path);
    await reconcileMark(change.path, document4);
    return true;
  }
  async function restore(change, file, body2, current) {
    const removed = current.get(change.restore.id);
    if (removed === void 0) return skip(change.path, "missing-in-linear");
    const seen = options.captured?.get(removed.id);
    const changed2 = seen === void 0 ? !removed.trashed && removed.archivedAt === null : seen.updatedAt !== removed.updatedAt || seen.trashed !== removed.trashed || seen.projectId !== removed.projectId || seen.teamId !== removed.teamId;
    if (changed2) return skip(change.path, "edited-in-linear");
    const document4 = await timed(async () => {
      if (removed.trashed || removed.archivedAt !== null) await linear.restoreDocument(removed.id);
      return linear.updateDocument(removed.id, { content: body2, title: file.title.normalize("NFC"), ...placePatch(file.place) });
    });
    result.restored.push(change.path);
    stored.set(change.path, { content: document4.content ?? "", sent: body2, document: document4 });
    nextIds.set(change.path, { id: document4.id });
    await reconcileMark(change.path, document4);
    return true;
  }
  async function findGoneRestores() {
    const restoring = merge.changes.filter((change) => change.kind === "create" && change.restore !== void 0);
    if (restoring.length === 0) return;
    let found;
    try {
      found = await linear.getDocuments(restoring.map((change) => change.restore.id));
    } catch (error) {
      if (!(error instanceof LinearError)) throw error;
      return;
    }
    const present = new Set(found.map((document4) => document4.id));
    for (const change of restoring) {
      const restore2 = change.restore;
      if (present.has(restore2.id)) continue;
      change.restore = { ...restore2, recreate: stableId("recreated", restore2.id) };
      const entry = merge.decided.find((decided) => decided.path === change.path);
      if (entry !== void 0) entry.summary = restore2.gone;
    }
  }
  async function reconcileMark(path2, document4) {
    const entry = nextIds.get(path2);
    if (entry === void 0 || entry.id !== document4.id || document4.content === void 0) return;
    await reconcileDocumentMark({
      document: document4,
      entry,
      linear,
      persistEntry: async (next) => {
        nextIds.set(path2, next);
        await pushIds();
      }
    });
  }
  async function pushIds() {
    for (const path2 of nextIds.keys()) nextReserved.delete(path2);
    const next = await commitIds(git, expected.ids, nextIds, identity, { message: IDS_MESSAGE, reserved: nextReserved });
    const pushed = await pushAtomic(git, options.config, [{ ref: stateRef(options.config, "ids"), expected: expected.ids, next }]);
    if (!pushed.ok) throw new StateMovedError2();
    expected.ids = next;
  }
  function placePatch(place) {
    const where = placeId(targets, place);
    return "projectId" in where ? { projectId: where.projectId } : { teamId: where.teamId, projectId: null };
  }
  function skip(path2, reason) {
    result.skipped.push({ path: path2, reason });
    return false;
  }
  function transformPlan() {
    const plan = { create: [], overwrite: [], trash: [], leftOut: [] };
    for (const change of merge.changes) {
      if (change.kind === "trash") continue;
      const path2 = changePath(change);
      const file = merge.result.get(path2);
      if (change.kind === "keep") plan.overwrite.push({ path: path2, title: file.title, place: file.place, documentId: change.id });
      else plan.create.push({ path: path2, title: file.title, place: file.place });
    }
    plan.leftOut = merge.leftOut.map((entry) => ({ path: entry.path, rules: entry.rules, lines: [] }));
    return plan;
  }
  async function record(merged) {
    const changes = /* @__PURE__ */ new Map();
    const fromTip = /* @__PURE__ */ new Set();
    const keepTip = (path2) => fromTip.add(path2);
    for (const [path2, { content: content4, sent }] of stored) {
      const file = merge.result.get(path2);
      const text4 = splitFile(textOf(file)).head + restoreBody(transforms, path2, content4, sent);
      if (resultFiles.get(path2) !== void 0 && text4 === textOf(file)) continue;
      changes.set(path2, text4);
    }
    for (const change of notDone) for (const path2 of pathsOf(change)) keepTip(path2);
    for (const path2 of merge.conflicts) keepTip(path2);
    if (!merged) {
      for (const path2 of /* @__PURE__ */ new Set([...linearFiles.keys(), ...resultFiles.keys()])) {
        const derived = !path2.endsWith(".md") || path2 === "README.md" || path2.endsWith("/README.md");
        if (derived && linearFiles.get(path2) !== resultFiles.get(path2)) keepTip(path2);
      }
    }
    for (const entry of merge.held) keepTip(entry.from);
    const tipBlobs = await readBlobs(git, [...fromTip].flatMap((path2) => linearFiles.has(path2) ? [linearFiles.get(path2)] : []));
    for (const path2 of fromTip) {
      const oid = linearFiles.get(path2);
      changes.set(path2, oid === void 0 ? null : tipBlobs.get(oid));
    }
    const parents = merged ? [linearTip, tracked] : [linearTip];
    const message = merged ? MERGE_RECORD_MESSAGE : PARTIAL_RECORD_MESSAGE;
    const commit = await commitTree(git, { parents, base: merge.tree, changes, message, identity, skipIfUnchanged: true });
    for (const path2 of nextIds.keys()) nextReserved.delete(path2);
    const asWritten = new Map(
      [...merged ? stored : []].flatMap(([path2, { document: document4 }]) => {
        const file = merge.result.get(path2);
        const held = !fromTip.has(path2) && file !== void 0 && document4.title.normalize("NFC") === file.title.normalize("NFC") && inPlace(document4, file.place);
        return held ? [[document4.id, document4.updatedAt]] : [];
      })
    );
    const idsCommit = await commitIds(git, expected.ids, nextIds, identity, { message: withRecorded(IDS_MESSAGE, asWritten), reserved: nextReserved, always: asWritten.size > 0 });
    const rebuilt = cacheLost && merged && result.stopped === void 0 ? { message: UPLOADS_REBUILT, always: true } : {};
    const uploadsCommit = expected.uploads === null && uploads.size === 0 && !cacheLost ? null : await commitUploads(git, expected.uploads, uploads, identity, rebuilt);
    const updates = [
      { ref: stateRef(options.config, "linear"), expected: linearTip, next: commit },
      { ref: stateRef(options.config, "ids"), expected: expected.ids, next: idsCommit }
    ];
    if (uploadsCommit !== null) updates.push({ ref: stateRef(options.config, "uploads"), expected: expected.uploads, next: uploadsCommit });
    const branch = options.createSyncBranch === true && commit !== linearTip ? { ref: branchRef(options.config.syncBranch), expected: null, next: commit } : void 0;
    let pushed = await pushAtomic(git, options.config, branch === void 0 ? updates : [...updates, branch]);
    if (!pushed.ok && pushed.reason === "rejected" && branch !== void 0) pushed = await pushAtomic(git, options.config, updates);
    if (!pushed.ok) return null;
    if (pushed.updated.length > 0) result.changed = true;
    result.state = { linear: commit, ids: idsCommit, uploads: uploadsCommit };
    const recorded2 = { commit, kind: merged ? "merge" : "ordinary", parents: commit === linearTip ? [] : parents };
    result.record = commit === linearTip ? null : recorded2;
    return recorded2;
  }
}
var UploadRefusedError = class extends LinearError {
  constructor() {
    super("FileUpload", "a linked file is not in the upload cache");
  }
};
function withoutUploads(client) {
  return new Proxy(client, {
    get(target, property) {
      if (property === "uploadFile" || property === "uploadFiles") {
        return async () => {
          throw new UploadRefusedError();
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    }
  });
}
async function wentOnFromPartial(git, tips) {
  for (const tip of new Set(tips)) {
    if (tip !== null && await git.text(["log", "-1", "--format=%s", tip]) === PARTIAL_RECORD_MESSAGE) return true;
  }
  return false;
}
function pathsOf(change) {
  if (change.kind === "keep") return change.from === change.to ? [change.to] : [change.from, change.to];
  return [change.path];
}
function stableId(...parts) {
  const hex = createHash8("sha256").update(parts.join("\0")).digest("hex");
  const variant = (parseInt(hex[16], 16) & 3 | 8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
function compare9(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

// src/sync/cycle.ts
async function runSyncCycle(context, options) {
  const state = { ...context.fetched.state };
  const trackedTip = context.fetched.tracked;
  const captured = await capture(context, { config: options.config, state, ...options.security ? { security: options.security } : {}, ...options.fetch ? { fetch: options.fetch } : {} });
  context.linear.transport.reads?.end();
  const changed2 = captured.changed.length > 0 || captured.removed.length > 0 || captured.blocked.length > 0;
  if (!captured.ok) return { complete: false, changed: changed2, trackedTip, capture: captured };
  await checkpoint("after-capture-push-before-pr");
  const pullRequest = await syncPullRequest(context, { config: options.config, state: captured.state, github: options.github, mergeGraceSeconds: options.mergeGraceSeconds });
  if (pullRequest.code === "initial-pull-request-pending" || pullRequest.code === "check-failed") return { complete: false, changed: changed2, trackedTip, capture: captured, pullRequest };
  const moved = pullRequest.branchMoved || pullRequest.merged !== null || pullRequest.pullRequest?.opened === true;
  const createSyncBranch = context.fetched.sync === null && !pullRequest.branchMoved;
  const write = await writeTrackedToLinear(context, { config: options.config, documentCap: options.documentCap, containers: captured.containers, createSyncBranch, state: captured.state, captured: captured.documents, ...options.transforms ? { transforms: options.transforms } : {} });
  return { complete: write.complete && pullRequest.code === void 0 && captured.heldRemovals.length === 0, changed: changed2 || moved || write.changed, trackedTip, capture: captured, pullRequest, write };
}

// src/sync/summary.ts
var SKIP_REASONS = {
  "edited-in-linear": "changed in Linear since it was read; the next run takes that change in and writes again",
  "missing-in-linear": "not found in Linear, or in its trash; the next run takes that in",
  conflict: "changed on both sides in a way git cannot merge; it is written when the conflict is resolved",
  "renamed-to-unwritable": "its file was renamed to one that is in conflict or left out; the document stays as it is until that is fixed"
};
function renderSync(result) {
  const write = result.write;
  const lines2 = ["## Sync", "", result.capture.summary, ""];
  if (result.pullRequest !== void 0) lines2.push(...renderPullRequest(result.pullRequest));
  if (write === void 0) {
    if (result.pullRequest === void 0) lines2.push("Capture did not finish; no tracked-branch changes were written.", "");
    return lines2.join("\n");
  }
  lines2.push("### Tracked branch to Linear", "");
  if (write.complete && write.record === null && !write.changed) {
    lines2.push("Linear already holds the tracked branch: nothing to write.", "");
  } else {
    const outcome2 = write.code === "container-cap" ? "Nothing was written. Reduce planned additions or increase document-cap after checking the container limit." : write.code === "state-moved" ? "A state ref moved while this run was writing, so it recorded nothing. Another run may be working on this repository; the next run writes again what is still missing." : write.complete ? "Linear now holds the tracked branch." : "Some documents were not written; the next run writes them.";
    lines2.push(
      outcome2,
      "",
      `- wrote ${count3(write.updated.length, "document")} with the file's new text;`,
      `- renamed or moved ${count3(write.relocated.length, "document")};`,
      `- created ${count3(write.created.length, "document")};`,
      `- restored ${count3(write.restored.length, "document")} that Linear had removed while git changed them;`,
      `- ${count3(write.conflicts.length, "document")} with conflict markers, where both sides changed the same lines; either side resolves them by editing the text;`,
      `- moved ${count3(write.trashed.length, "document")} of removed files to Linear's trash, from which they can be restored;`,
      `- skipped ${count3(write.skipped.length, "document")};`,
      `- left out ${count3(write.leftOut.length + write.leftOutAtWrite.length, "file")}, which stay in git only until they are fixed.`,
      ""
    );
  }
  if (write.code === "state-moved") lines2.push(`This run is ${PARTIAL}: the next run writes again what is still missing.`, "");
  else if (write.code !== void 0 && write.code !== "container-cap") lines2.push(`This run is ${PARTIAL}: it recorded what it finished, and the next run goes on from there.`, "");
  if (write.stopped !== void 0) {
    lines2.push(...renderStop(write.stopped), `Not written yet: ${count3(write.notAttempted.length, "item")}.`, "");
  }
  const table = (title, head, rows) => {
    if (rows.length === 0) return;
    lines2.push(`#### ${title} (${rows.length})`, "", `| ${head.join(" | ")} |`, `| ${head.map(() => "---").join(" | ")} |`);
    for (const row of rows) lines2.push(`| ${row.map(cell).join(" | ")} |`);
    lines2.push("");
  };
  table("Failed", ["Path", "Operation", "Error"], write.failed.map((entry) => [entry.path, entry.operation, entry.error]));
  table("Skipped", ["Path", "Why"], write.skipped.map((entry) => [entry.path, SKIP_REASONS[entry.reason]]));
  table("Conflict markers", ["Path"], write.conflicts.map((path2) => [path2]));
  table("Decided by the conflict rules", ["Rule", "What happened"], write.decided.map((entry) => [entry.summary.code, entry.summary.text]));
  table("Renamed or moved", ["From", "To"], write.relocated.map((entry) => [entry.from, entry.to]));
  table("Moved to trash", ["Path"], write.trashed.map((path2) => [path2]));
  table("Left out", ["Path", "Rules"], [...write.leftOut.map((entry) => [entry.path, entry.rules.join(", ")]), ...write.leftOutAtWrite.map((entry) => [entry.path, entry.rule])]);
  return lines2.join("\n") + renderCapacity(write.capacity ?? []);
}
function count3(n, noun) {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

// src/run/operation.ts
import { rm as rm6 } from "node:fs/promises";

// src/sync/staged.ts
import { createHash as createHash9 } from "node:crypto";
import { mkdir as mkdir3, readFile as readFile3, rm as rm5, writeFile as writeFile4 } from "node:fs/promises";
import { join as join8 } from "node:path";
var MANIFEST = "manifest.json";
var ANSWERS = "answers.json";
var READS = "linear-reads";
var VERSION3 = 1;
var readsFolder = (folder) => join8(folder, READS);
var sha2564 = (content4) => createHash9("sha256").update(content4).digest("hex");
function candidateKey(files) {
  const pairs = [...files].map(([path2, content4]) => [path2, sha2564(content4)]).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  return sha2564(JSON.stringify(pairs));
}
async function stagingGate(git, tracked, folder) {
  const configured = (await securityHookIds(git, tracked)).length > 0;
  await rm5(folder, { recursive: true, force: true });
  await mkdir3(join8(folder, "files"), { recursive: true, mode: 448 });
  const sets = /* @__PURE__ */ new Map();
  return {
    configured,
    async check(files) {
      if (!configured) return [];
      const key = candidateKey(files);
      if (!sets.has(key)) {
        const entries = [];
        for (const [path2, content4] of files) {
          checkRepoPath(path2);
          const hash = sha2564(content4);
          await writeFile4(join8(folder, "files", hash), content4, { mode: 384 });
          entries.push({ path: path2, sha256: hash });
        }
        sets.set(key, { key, files: entries });
      }
      return [];
    },
    async finish() {
      const manifest = { version: VERSION3, tracked, sets: [...sets.values()] };
      await writeFile4(join8(folder, MANIFEST), JSON.stringify(manifest), { mode: 384 });
      return sets.size;
    }
  };
}
async function stageNothing(folder, tracked) {
  await rm5(folder, { recursive: true, force: true });
  await mkdir3(folder, { recursive: true, mode: 448 });
  await writeFile4(join8(folder, MANIFEST), JSON.stringify({ version: VERSION3, tracked: tracked ?? "", sets: [] }), { mode: 384 });
}
async function answeringGate(git, tracked, folder) {
  const hooks = new Set(await securityHookIds(git, tracked));
  const configured = hooks.size > 0;
  let answers = {};
  if (configured) {
    const text4 = await readFile3(join8(folder, ANSWERS), "utf8").catch(() => null);
    const read = text4 === null ? null : JSON.parse(text4);
    if (read !== null && read.version === VERSION3 && read.tracked === tracked) answers = read.answers;
  }
  return {
    configured,
    async check(files) {
      if (!configured) return [];
      const key = candidateKey(files);
      const found = Object.hasOwn(answers, key) ? answers[key] : void 0;
      if (!Array.isArray(found)) return null;
      return found.map(({ hook, line: line2 }) => ({ hook: hooks.has(hook) ? hook : SECURITY_ALIAS, line: Number.isSafeInteger(line2) && line2 > 0 ? line2 : 1 }));
    }
  };
}

// src/run/operation.ts
function noWrites() {
  return { linear: {}, git: {}, pullRequests: {} };
}
function sortedCounts(counts2) {
  return Object.fromEntries([...counts2].filter(([, count4]) => count4 > 0).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
}
function movedSince(before, after) {
  return new Map([...after].map(([role, count4]) => [role, count4 - (before.get(role) ?? 0)]));
}
async function runOperation(operation, inputs, initialSync, options, security) {
  if (operation === "initial-sync" !== (initialSync !== void 0)) {
    throw new Error("the direction and confirm inputs belong to an initial sync, and only to it");
  }
  if (security?.step === "stage" && operation === "initial-sync" && !(initialSync?.direction === "linear-to-git" && initialSync.confirm)) {
    await stageNothing(security.folder, null);
    return { operation, ok: true, notImplemented: false, refusedPushes: [], summary: renderStaged(0), staged: { sets: 0 }, writes: noWrites() };
  }
  try {
    const reads = security?.step === "stage" ? LinearReads.recording() : security?.step === "apply" ? await LinearReads.replaying(readsFolder(security.folder)) : null;
    const outcome2 = await runWithSecurity(operation, inputs, initialSync, reads === null ? options : { ...options, reads }, security);
    if (security?.step !== "stage" || !outcome2.ok) return outcome2;
    const staged = outcome2.staged === void 0 ? { ...outcome2, staged: { sets: 0 }, summary: `${outcome2.summary.trimEnd()}

${renderStaged(0)}` } : outcome2;
    if (outcome2.staged === void 0) await stageNothing(security.folder, null);
    await reads?.save(readsFolder(security.folder));
    return staged;
  } finally {
    if (security?.step === "apply") await rm6(security.folder, { recursive: true, force: true });
  }
}
async function runWithSecurity(operation, inputs, initialSync, options, security) {
  let staged;
  let plan;
  let confirmed;
  let reverse;
  let sync;
  let workSummary = "";
  const pullRequestWrites = /* @__PURE__ */ new Map();
  const refsBefore = movedRefs(options.git);
  const transforms = () => [uploadsTransform({ config: inputs.state }), documentLinks()];
  const gitToLinear = async (context, confirm) => {
    if (confirm) {
      const run = await confirmInitialSync(context, { config: inputs.state, documentCap: inputs.documentCap, transforms: transforms() });
      plan = toPlanReport(run.plan, "git-to-linear", true);
      confirmed = run.result;
      workSummary = renderConfirmed(run.plan, run.result);
    } else {
      const planned = await planFromRepository(context, inputs.documentCap);
      plan = toPlanReport(planned, "git-to-linear", false);
      workSummary = renderDryRun(planned);
    }
  };
  const linearToGit = async (context, confirm) => {
    if (confirm) {
      const github = { ...inputs.github, writes: pullRequestWrites, ...options.fetch ? { fetch: options.fetch } : {} };
      if (security?.step === "stage") {
        const gate2 = await stagingGate(context.git, context.fetched.tracked, security.folder);
        const ended = gate2.configured ? (await confirmLinearToGit(context, { config: inputs.state, github, security: gate2, stageOnly: true })).result.code : void 0;
        staged = { sets: await gate2.finish() };
        workSummary = renderStaged(staged.sets) + (ended === void 0 ? "" : `

Staging stopped early (${ended}).`);
        return;
      }
      const gate = security?.step === "apply" ? { security: await answeringGate(context.git, context.fetched.tracked, security.folder) } : {};
      const run = await confirmLinearToGit(context, { config: inputs.state, github, ...gate });
      plan = toReversePlanReport(run.plan, true);
      reverse = run.result;
      workSummary = renderReverseConfirmed(run.plan, run.result);
    } else {
      const planned = await planLinearToGitFromRepository(context);
      plan = toReversePlanReport(planned, false);
      workSummary = renderReverseDryRun(planned);
    }
  };
  const syncCycle = async (context) => {
    if (security?.step === "stage") {
      const gate = await stagingGate(context.git, context.fetched.tracked, security.folder);
      let stopped = "";
      if (gate.configured) {
        const result = await capture(context, { config: inputs.state, state: { ...context.fetched.state }, security: gate, stageOnly: true, ...options.fetch ? { fetch: options.fetch } : {} });
        if (!result.ok) stopped = `

${result.summary}`;
      }
      staged = { sets: await gate.finish() };
      workSummary = renderStaged(staged.sets) + stopped;
      return;
    }
    sync = await runSyncCycle(context, {
      ...security?.step === "apply" ? { security: await answeringGate(context.git, context.fetched.tracked, security.folder) } : {},
      config: inputs.state,
      documentCap: inputs.documentCap,
      mergeGraceSeconds: inputs.mergeGraceSeconds,
      github: { ...inputs.github, writes: pullRequestWrites, ...options.fetch ? { fetch: options.fetch } : {} },
      transforms,
      ...options.fetch ? { fetch: options.fetch } : {}
    });
    workSummary = renderSync(sync);
  };
  const refusePending = initialSync?.direction === "git-to-linear" && initialSync.confirm;
  const { linearWrites, ...preflight } = await runPreflight(
    operation,
    inputs,
    refusePending ? { ...options, refusePendingInitialPullRequest: true } : options,
    operation === "sync" ? syncCycle : initialSync === void 0 ? void 0 : (context) => (initialSync.direction === "git-to-linear" ? gitToLinear : linearToGit)(context, initialSync.confirm)
  );
  const refused = refusedPushes(options.git);
  const writes = {
    linear: sortedCounts(linearWrites ?? /* @__PURE__ */ new Map()),
    git: sortedCounts(movedSince(refsBefore, movedRefs(options.git))),
    pullRequests: sortedCounts(pullRequestWrites)
  };
  if (!preflight.ok) return { ...preflight, notImplemented: false, refusedPushes: refused, writes };
  const outcome2 = { ...preflight, notImplemented: false, refusedPushes: refused, writes };
  if (plan !== void 0) outcome2.plan = plan;
  if (workSummary !== "") outcome2.summary = `${preflight.summary.trimEnd()}

${workSummary}`;
  if (confirmed !== void 0) outcome2.confirmed = confirmed;
  if (reverse !== void 0) outcome2.reverse = reverse;
  if (sync !== void 0) {
    outcome2.sync = sync;
    outcome2.captured = sync.capture;
  }
  if (staged !== void 0) outcome2.staged = staged;
  return outcome2;
}
function renderStaged(sets) {
  return sets === 0 ? "Nothing staged for the security hooks: none are configured, or Linear has no changes for them." : `Staged ${sets} sets of files for the security hooks; nothing was written to the repository or Linear.`;
}

// src/run/exit.ts
function partialCode(outcome2) {
  if (pullRequestEnding(outcome2) !== null) return void 0;
  return linearPartialCode(outcome2);
}
function pullRequestEnding(outcome2) {
  const failure = pullRequestFailure(outcome2.sync?.pullRequest);
  if (failure === null) return null;
  if (failure.kind === "incomplete" && linearPartialCode(outcome2) !== void 0) return null;
  return failure;
}
function exitStatusOf(outcome2) {
  if (partialCode(outcome2) !== void 0) return "warning";
  if (!outcome2.ok || outcome2.notImplemented) return "failure";
  if (outcome2.sync?.write?.code === "container-cap" || pullRequestEnding(outcome2) !== null) return "failure";
  const unfinished = outcome2.confirmed ?? outcome2.reverse;
  if (unfinished !== void 0 && !unfinished.complete) return "failure";
  return "success";
}
function stoppedBeforeWritingMessage(command, outcome2) {
  const detail = outcome2.setup?.detail ?? outcome2.refusal?.message;
  const fix = fixUrl(outcome2.code);
  const explained = `${command}: stopped before any write (${outcome2.code})${detail === void 0 ? "" : `: ${detail.replace(/\s*[\r\n]+\s*/g, " ")}`}`;
  return fix === void 0 ? explained : `${explained.replace(/\.$/, "")}. How to fix it: ${fix}`;
}
function stoppedMessage(outcome2) {
  if (outcome2.stopped === void 0 || partialCode(outcome2) !== void 0) return void 0;
  return `${outcome2.operation}: stopped by Linear before any write; run it again once the limit has reset`;
}
function linearPartialCode(outcome2) {
  if (outcome2.operation !== "sync") return void 0;
  if (outcome2.stopped !== void 0) return "stopped";
  if (outcome2.captured !== void 0 && !outcome2.captured.ok) return outcome2.captured.code ?? "stopped";
  const code2 = outcome2.sync?.write?.code;
  if (code2 !== void 0) return code2 === "container-cap" ? void 0 : code2;
  return (outcome2.captured?.heldRemovals.length ?? 0) > 0 ? "removal-held" : void 0;
}

// src/run/finish.ts
import { mkdir as mkdir4, writeFile as writeFile5 } from "node:fs/promises";
import { dirname as dirname2 } from "node:path";
function toRunReport(outcome2) {
  if (outcome2.sync?.write !== void 0) return toSyncRunReport(outcome2, outcome2.sync.write);
  const confirmed = outcome2.confirmed;
  const reverse = outcome2.reverse;
  return {
    capacity: outcome2.plan?.capacity ?? [],
    operation: outcome2.operation,
    ok: outcome2.ok,
    code: outcome2.code ?? outcome2.captured?.code ?? pullRequestEnding(outcome2)?.code ?? confirmed?.code ?? reverse?.code ?? (outcome2.stopped === void 0 ? null : "stopped"),
    exitStatus: exitStatusOf(outcome2),
    stop: outcome2.stopped ?? outcome2.captured?.stopped ?? confirmed?.stopped ?? reverse?.stopped ?? null,
    complete: outcome2.sync?.complete ?? confirmed?.complete ?? reverse?.complete ?? false,
    changed: outcome2.sync?.changed ?? (confirmed !== void 0 && (confirmed.created.length + confirmed.overwritten.length + confirmed.trashed.length > 0 || confirmed.record?.moved === true) || reverse !== void 0 && (reverse.record?.moved === true || reverse.progressPushes > 0 || reverse.pullRequest?.opened === true || reverse.pullRequest?.updated === true || reverse.closedPullRequest !== void 0)),
    setupChecks: (outcome2.setup?.checks ?? []).map(({ name, state, detail }) => ({ name, state, detail })),
    securityHooks: outcome2.setup?.securityHooks ?? null,
    notImplemented: outcome2.notImplemented,
    summary: outcome2.plan ?? null,
    initialSync: confirmed === void 0 ? null : toConfirmedReport(confirmed),
    capture: captureReport(outcome2.captured),
    pullRequest: outcome2.sync?.pullRequest ?? null,
    sync: null,
    writtenCount: confirmed === void 0 ? 0 : confirmed.created.length + confirmed.overwritten.length,
    skippedCompletedCount: confirmed?.skippedCompleted.length ?? reverse?.skippedCompleted.length ?? 0,
    // A confirmed run finds them at the write; a dry run, before it, and lists them in its plan.
    oversizeFiles: [
      ...new Set(
        confirmed !== void 0 ? confirmed.leftOutAtWrite.filter((entry) => entry.rule === UPLOAD_TOO_LARGE).flatMap((entry) => entry.files ?? []) : (outcome2.plan?.leftOutFiles ?? []).filter((entry) => entry.rules.includes(UPLOAD_TOO_LARGE)).flatMap((entry) => entry.files ?? [])
      )
    ].sort(),
    leftOutRules: outcome2.plan === void 0 ? null : ruleList([
      ...outcome2.plan.leftOutFiles.flatMap((entry) => entry.rules),
      ...(confirmed?.leftOutAtWrite ?? []).map((entry) => entry.rule),
      ...(reverse?.leftOutAtRecord ?? []).map((entry) => entry.rule)
    ]),
    paths: pathsOf2(outcome2),
    resumed: confirmed?.resumed ?? reverse?.resumed ?? false,
    ...faultFacts(outcome2, outcome2.stopped ?? outcome2.captured?.stopped ?? confirmed?.stopped ?? reverse?.stopped, confirmed?.failed ?? [], [...confirmed?.created ?? [], ...confirmed?.overwritten ?? []]),
    stoppedEarly: confirmed?.stopped !== void 0 || reverse?.stopped !== void 0 || outcome2.stopped !== void 0 || outcome2.captured?.stopped !== void 0,
    // A stopped run pushes the ids it has before it ends; only a state ref that moved under it prevents that.
    progressRecorded: confirmed?.progressRecorded ?? (reverse !== void 0 && reverse.code !== "state-moved"),
    record: confirmed?.record == null ? null : {
      kind: "initial",
      commit: confirmed.record.linear,
      moved: confirmed.record.moved,
      hasTrackedParent: confirmed.record.hasTrackedParent,
      reformattedCount: confirmed.record.reformatted.length
    },
    linearToGit: reverse === void 0 ? null : toReverseReport(reverse),
    ...raceFacts(outcome2),
    writes: outcome2.writes
  };
}
function toReverseReport(result) {
  return {
    complete: result.complete,
    overwritten: result.overwritten,
    created: result.created,
    skippedCompleted: result.skippedCompleted,
    removed: result.removed,
    leftOutAtRecord: result.leftOutAtRecord,
    notAttempted: result.notAttempted,
    stopped: result.stopped ?? null,
    progressPushes: result.progressPushes,
    record: result.record === null ? null : { commit: result.record.linear, moved: result.record.moved, hasTrackedParent: result.record.hasTrackedParent, changesTracked: result.record.changesTracked },
    pullRequest: result.pullRequest === null ? null : { number: result.pullRequest.number, url: result.pullRequest.url, opened: result.pullRequest.opened, updated: result.pullRequest.updated },
    closedPullRequest: result.closedPullRequest ?? null
  };
}
function toSyncRunReport(outcome2, write) {
  return {
    capacity: write.capacity ?? [],
    operation: outcome2.operation,
    ok: outcome2.ok,
    code: outcome2.code ?? pullRequestEnding(outcome2)?.code ?? write.code ?? partialCode(outcome2) ?? null,
    exitStatus: exitStatusOf(outcome2),
    stop: write.stopped ?? null,
    complete: outcome2.sync.complete,
    changed: outcome2.sync.changed,
    setupChecks: (outcome2.setup?.checks ?? []).map(({ name, state, detail }) => ({ name, state, detail })),
    securityHooks: outcome2.setup?.securityHooks ?? null,
    notImplemented: false,
    summary: null,
    initialSync: null,
    capture: captureReport(outcome2.captured),
    pullRequest: outcome2.sync?.pullRequest ?? null,
    sync: {
      complete: write.complete,
      updated: write.updated,
      relocated: write.relocated,
      created: write.created,
      adopted: write.adopted,
      restored: write.restored,
      trashed: write.trashed,
      conflicts: write.conflicts,
      decided: write.decided,
      skipped: write.skipped,
      leftOut: write.leftOut,
      leftOutAtWrite: write.leftOutAtWrite,
      failed: write.failed,
      notAttempted: write.notAttempted,
      stopped: write.stopped ?? null,
      record: write.record
    },
    writtenCount: (/* @__PURE__ */ new Set([...write.updated, ...write.created, ...write.restored, ...write.relocated.map((entry) => entry.to)])).size,
    skippedCompletedCount: 0,
    oversizeFiles: [...new Set(write.leftOutAtWrite.filter((entry) => entry.rule === UPLOAD_TOO_LARGE).flatMap((entry) => entry.files ?? []))].sort(),
    leftOutRules: ruleList([...write.leftOut.flatMap((entry) => entry.rules), ...write.leftOutAtWrite.map((entry) => entry.rule)]),
    paths: pathsOf2(outcome2),
    resumed: write.resumed,
    ...faultFacts(outcome2, write.stopped, write.failed, [...write.updated, ...write.created, ...write.relocated.map((entry) => entry.to)]),
    stoppedEarly: write.stopped !== void 0,
    progressRecorded: write.code !== "state-moved",
    record: write.record === null ? null : { kind: write.record.kind, commit: write.record.commit, hasTrackedParent: write.record.parents.length > 1 },
    linearToGit: null,
    ...raceFacts(outcome2),
    writes: outcome2.writes
  };
}
function ruleList(rules) {
  return [...new Set(rules)].sort();
}
function pathsOf2(outcome2) {
  return outcome2.captured !== void 0 || outcome2.plan?.direction === "linear-to-git" ? { rule: PATH_RULE } : null;
}
function raceFacts(outcome2) {
  const write = outcome2.sync?.write;
  return {
    atomicPushRefused: outcome2.refusedPushes.length > 0,
    partialRefUpdates: outcome2.refusedPushes.reduce((sum, push2) => sum + push2.moved.length, 0),
    skippedConcurrentDocument: write?.skipped.some((entry) => entry.reason === "edited-in-linear" || entry.reason === "missing-in-linear") ?? false,
    capturedTrackedTip: outcome2.sync?.trackedTip ?? null,
    rereadWindowMs: write?.rereadWindowMs ?? null
  };
}
var WRITES = /* @__PURE__ */ new Set(["CreateDocument", "UpdateDocument", "TrashDocument"]);
function faultFacts(outcome2, stop, failed2, written) {
  const recorded = new Set(written);
  const limits = stop === void 0 || stop.kind === "test-threshold" ? {} : stop.limits ?? {};
  const endpointHeaders = Object.keys(limits).filter((name) => name.startsWith("x-ratelimit-endpoint-"));
  const rejected = failed2.filter((entry) => WRITES.has(entry.operation) && entry.error.startsWith("LinearGraphQLError") && !/HTTP 5\d\d/.test(entry.error));
  return {
    writtenDocuments: recorded.size,
    writesAfterLimit: outcome2.writesAfterStop ?? 0,
    failedWriteRecorded: failed2.some((entry) => recorded.has(entry.path)),
    endpointLimitHeadersPresent: endpointHeaders.length > 0 && endpointHeaders.every((name) => outcome2.summary.includes(`| ${name} |`)),
    rejectedDocumentNamed: rejected.length > 0 && rejected.every((entry) => outcome2.summary.includes(cell(entry.path)))
  };
}
function toConfirmedReport(result) {
  return {
    complete: result.complete,
    created: result.created,
    overwritten: result.overwritten,
    unchanged: result.unchanged,
    skippedCompleted: result.skippedCompleted,
    trashed: result.trashed,
    leftOutAtWrite: result.leftOutAtWrite,
    failed: result.failed,
    notAttempted: result.notAttempted,
    stopped: result.stopped ?? null,
    progressPushes: result.progressPushes,
    reformatted: result.record?.reformatted ?? []
  };
}
function unfinishedMessage(command, code2) {
  if (code2 === "sync-branch-changed") {
    return `${command}: not finished (${code2}); merge or close the pull request of the sync branch and delete the branch, then run it again`;
  }
  return `${command}: not finished (${code2}); run it again with the same inputs`;
}
async function writeRunReport(path2, outcome2) {
  await mkdir4(dirname2(path2), { recursive: true });
  await writeFile5(path2, `${JSON.stringify(toRunReport(outcome2), null, 2)}
`);
}
function captureReport(captured) {
  return captured === void 0 ? null : { ok: captured.ok, changed: captured.changed, removed: captured.removed, heldRemovals: captured.heldRemovals, blocked: captured.blocked, leftOut: captured.leftOut, writeBackWarnings: captured.writeBackWarnings, ...captured.stopped ? { stopped: captured.stopped } : {}, ...captured.rebuiltIds ? { rebuiltIds: captured.rebuiltIds } : {} };
}

// src/init/command.ts
var import_yaml3 = __toESM(require_dist(), 1);
import { lstat, mkdir as mkdir5, readFile as readFile4, readdir, realpath, writeFile as writeFile6 } from "node:fs/promises";
import { dirname as dirname3, isAbsolute as isAbsolute2, join as join9, relative as relative2, resolve as resolve2, sep as sep2 } from "node:path";

// src/init/workflows.json
var workflows_default = {
  "mdbisync-initial-sync.yml": `# Copy to .github/workflows/mdbisync-initial-sync.yml in a synchronized
# repository, next to the sync workflow (mdbisync.yml).
#
# Initial sync makes one side equal to the other before the first sync, and
# restores the sync after its state is lost. Run it by hand from the Actions
# tab. Without \`confirm\` it is a dry run: the job summary lists by path what
# it would create, overwrite, move to Linear's trash and leave out, and
# nothing is written.
#
# It is destructive to the target side:
# - git-to-linear: Linear documents of the synchronized teams and projects
#   that have no file are moved to Linear's trash (restorable there).
# - linear-to-git: one pull request removes the synchronized files that have
#   no document; a person reviews and merges it.
#
# Needs: the repository variable MDBISYNC_APP_CLIENT_ID and the secrets
# MDBISYNC_APP_PRIVATE_KEY (the sync's GitHub App), MDBISYNC_LINEAR_CLIENT_ID
# and MDBISYNC_LINEAR_CLIENT_SECRET (the Linear OAuth app).
name: mdbisync initial sync

on:
  workflow_dispatch:
    inputs:
      direction:
        description: "git-to-linear (Linear is made equal to main) or linear-to-git (a pull request makes main equal to Linear)"
        type: string
        required: true
      confirm:
        description: "Write. Leave unchecked for a dry run that writes nothing."
        type: boolean
        default: false

permissions: {}

# The same group as the sync workflow: one run at a time, never cancelled.
# GitHub keeps one pending run per group, and a newer one replaces it: if a
# sync is running when you start this workflow, a sync queued after it can
# replace this run. Disable the sync workflow while you run initial sync.
concurrency:
  group: mdbisync
  cancel-in-progress: false

jobs:
  initial-sync:
    runs-on: ubuntu-latest
    # The App token lives one hour. A longer initial sync stops here; start
    # the workflow again with the same inputs and it goes on where it stopped.
    timeout-minutes: 55
    steps:
      - name: Get the GitHub App token
        id: app-token
        uses: actions/create-github-app-token@64ab729a6294000f5aa4a4bc0b73d1f32bc45510 # v3.3.0
        with:
          client-id: \${{ vars.MDBISYNC_APP_CLIENT_ID }}
          private-key: \${{ secrets.MDBISYNC_APP_PRIVATE_KEY }}
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          token: \${{ steps.app-token.outputs.token }}
          fetch-depth: 0
          persist-credentials: false
      # From Linear, the repository's hooks marked \`alias: security\` check
      # Linear's documents before anything is pushed; they run with pre-commit.
      - name: Install pre-commit
        shell: bash
        run: |
          if ! command -v pre-commit >/dev/null 2>&1; then
            if ! command -v python3 >/dev/null 2>&1; then
              echo '::error::Install Python 3 with venv support, or provide pre-commit on PATH.'
              exit 1
            fi
            environment=$(mktemp -d "$RUNNER_TEMP/pre-commit.XXXXXX")
            if ! python3 -m venv "$environment"; then
              echo '::error::Python 3 venv support is required; install it, or provide pre-commit on PATH.'
              exit 1
            fi
            if ! "$environment/bin/python" -m pip install pre-commit==4.6.2; then
              echo '::error::Could not install pre-commit 4.6.2; use Python 3.10+ and allow access to PyPI.'
              exit 1
            fi
            mkdir "$environment/commands"
            ln -s "$environment/bin/pre-commit" "$environment/commands/pre-commit"
            echo "$environment/commands" >> "$GITHUB_PATH"
          fi
      # A confirmed run from Linear reads Linear's documents into the
      # runner's temporary directory for the hooks; any other run has nothing
      # to stage. It writes nothing. The action revokes its Linear token when
      # it ends, and again in its post step after a failed or cancelled run.
      - name: Stage Linear's documents
        id: stage
        uses: mdbisync/mdbisync@79db9969462ae7f1f00c88e95b311e61db3c455e # v0.1.0-rc.2
        with:
          operation: initial-sync
          security-step: stage
          # Requires a dedicated Linear app for these two serialized workflows.
          # Enable only when no other repository or worker uses this app.
          cleanup-tokens: false
          direction: \${{ inputs.direction }}
          confirm: \${{ inputs.confirm }}
          github-token: \${{ steps.app-token.outputs.token }}
          linear-client-id: \${{ secrets.MDBISYNC_LINEAR_CLIENT_ID }}
          linear-client-secret: \${{ secrets.MDBISYNC_LINEAR_CLIENT_SECRET }}
      # The security hooks in a step of their own: it holds no Linear secret
      # or token and no App token. Give it only the keys your hooks need.
      - name: Run the security hooks
        # A release without the staged steps gives no command and ran its hooks itself.
        if: steps.stage.outputs.hooks != ''
        run: '"$MDBISYNC_NODE" "$MDBISYNC_HOOKS"'
        env:
          MDBISYNC_NODE: \${{ steps.stage.outputs.node }}
          MDBISYNC_HOOKS: \${{ steps.stage.outputs.hooks }}
          # SCANNER_API_KEY: \${{ secrets.SCANNER_API_KEY }}
      # Takes Linear's documents from the stage step's reads, so it records
      # what the hooks saw; a document they have not seen (the hooks step did
      # not run) keeps the tracked branch's version and is listed as left out.
      - name: Initial sync
        uses: mdbisync/mdbisync@79db9969462ae7f1f00c88e95b311e61db3c455e # v0.1.0-rc.2
        with:
          operation: initial-sync
          security-step: apply
          direction: \${{ inputs.direction }}
          confirm: \${{ inputs.confirm }}
          github-token: \${{ steps.app-token.outputs.token }}
          linear-client-id: \${{ secrets.MDBISYNC_LINEAR_CLIENT_ID }}
          linear-client-secret: \${{ secrets.MDBISYNC_LINEAR_CLIENT_SECRET }}
`,
  "mdbisync.yml": `# Copy to .github/workflows/mdbisync.yml in a synchronized repository, next
# to the initial sync workflow (mdbisync-initial-sync.yml).
#
# Keep this workflow disabled until the initial sync has finished: until
# then each run writes nothing and fails with \`initial-sync-required\`, and
# a sync queued in the shared group can replace a pending initial sync.
# Disable it again before any later initial sync (recovery).
#
# Each run takes Linear's changes to main through the sync pull request,
# which the sync merges once its checks pass, and writes main's changes to
# Linear. It runs on every push to main, every five minutes, and by hand.
#
# Needs: the repository variable MDBISYNC_APP_CLIENT_ID and the secrets
# MDBISYNC_APP_PRIVATE_KEY (the sync's GitHub App), MDBISYNC_LINEAR_CLIENT_ID
# and MDBISYNC_LINEAR_CLIENT_SECRET (the Linear OAuth app).
name: mdbisync

on:
  push:
    branches: [main]
  # GitHub runs schedules only on the default branch, may start them late,
  # and turns them off in a public repository after 60 days without activity.
  schedule:
    - cron: "*/5 * * * *"
  workflow_dispatch:

permissions: {}

# The same group as the initial sync: one run at a time, never cancelled.
concurrency:
  group: mdbisync
  cancel-in-progress: false

jobs:
  sync:
    runs-on: ubuntu-latest
    # The App token lives one hour; the next run goes on where this one stopped.
    timeout-minutes: 55
    steps:
      - name: Get the GitHub App token
        id: app-token
        uses: actions/create-github-app-token@64ab729a6294000f5aa4a4bc0b73d1f32bc45510 # v3.3.0
        with:
          client-id: \${{ vars.MDBISYNC_APP_CLIENT_ID }}
          private-key: \${{ secrets.MDBISYNC_APP_PRIVATE_KEY }}
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          token: \${{ steps.app-token.outputs.token }}
          fetch-depth: 0
          persist-credentials: false
      # The repository's hooks marked \`alias: security\` check Linear's
      # changes before anything is pushed; they run with pre-commit.
      - name: Install pre-commit
        shell: bash
        run: |
          if ! command -v pre-commit >/dev/null 2>&1; then
            if ! command -v python3 >/dev/null 2>&1; then
              echo '::error::Install Python 3 with venv support, or provide pre-commit on PATH.'
              exit 1
            fi
            environment=$(mktemp -d "$RUNNER_TEMP/pre-commit.XXXXXX")
            if ! python3 -m venv "$environment"; then
              echo '::error::Python 3 venv support is required; install it, or provide pre-commit on PATH.'
              exit 1
            fi
            if ! "$environment/bin/python" -m pip install pre-commit==4.6.2; then
              echo '::error::Could not install pre-commit 4.6.2; use Python 3.10+ and allow access to PyPI.'
              exit 1
            fi
            mkdir "$environment/commands"
            ln -s "$environment/bin/pre-commit" "$environment/commands/pre-commit"
            echo "$environment/commands" >> "$GITHUB_PATH"
          fi
      # Reads Linear's changes into the runner's temporary directory for the
      # hooks and writes nothing. The action revokes its Linear token when it
      # ends, and again in its post step after a failed or cancelled run.
      - name: Stage Linear's changes
        id: stage
        uses: mdbisync/mdbisync@79db9969462ae7f1f00c88e95b311e61db3c455e # v0.1.0-rc.2
        with:
          operation: sync
          security-step: stage
          # Requires a dedicated Linear app for these two serialized workflows.
          # Enable only when no other repository or worker uses this app.
          cleanup-tokens: false
          github-token: \${{ steps.app-token.outputs.token }}
          linear-client-id: \${{ secrets.MDBISYNC_LINEAR_CLIENT_ID }}
          linear-client-secret: \${{ secrets.MDBISYNC_LINEAR_CLIENT_SECRET }}
      # The security hooks in a step of their own: it holds no Linear secret
      # or token and no App token. Give it only the keys your hooks need.
      - name: Run the security hooks
        # A release without the staged steps gives no command and ran its hooks itself.
        if: steps.stage.outputs.hooks != ''
        run: '"$MDBISYNC_NODE" "$MDBISYNC_HOOKS"'
        env:
          MDBISYNC_NODE: \${{ steps.stage.outputs.node }}
          MDBISYNC_HOOKS: \${{ steps.stage.outputs.hooks }}
          # SCANNER_API_KEY: \${{ secrets.SCANNER_API_KEY }}
      # Syncs both ways, taking Linear's changes from the stage step's reads,
      # so it pushes what the hooks saw; a later change in Linear waits for
      # the next run.
      - name: Sync
        uses: mdbisync/mdbisync@79db9969462ae7f1f00c88e95b311e61db3c455e # v0.1.0-rc.2
        with:
          operation: sync
          security-step: apply
          github-token: \${{ steps.app-token.outputs.token }}
          linear-client-id: \${{ secrets.MDBISYNC_LINEAR_CLIENT_ID }}
          linear-client-secret: \${{ secrets.MDBISYNC_LINEAR_CLIENT_SECRET }}
`,
  "pre-commit.yml": `# Copy to .github/workflows/pre-commit.yml in a synchronized repository.
# Install Node 24 and pre-commit locally too. Hook revs must pin release
# commits containing dist/cli.js and a dependency-free package.json.
name: Pre-commit

on:
  pull_request:

permissions:
  contents: read

concurrency:
  group: pre-commit-\${{ github.event.pull_request.number }}
  cancel-in-progress: true

jobs:
  pre-commit:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    permissions:
      contents: write # Fork pull requests retain a read-only token.
      checks: write # Attach the result to the fixing commit too.
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          repository: \${{ github.event.pull_request.head.repo.full_name }}
          ref: \${{ github.event.pull_request.head.sha }}
          persist-credentials: false
      - uses: actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1 # v7.1.0
        with:
          node-version: 24
      - name: Install compatible npm
        run: npm install --global --ignore-scripts npm@11.16.0
      - name: Install pre-commit
        shell: bash
        run: |
          if [[ "$(pre-commit --version 2>/dev/null || true)" != "pre-commit 4.6.2" ]]; then
            if ! command -v python3 >/dev/null 2>&1; then
              echo '::error::Install Python 3 with venv support, or provide pre-commit on PATH.'
              exit 1
            fi
            environment=$(mktemp -d "$RUNNER_TEMP/pre-commit.XXXXXX")
            if ! python3 -m venv "$environment"; then
              echo '::error::Python 3 venv support is required; install it, or provide pre-commit on PATH.'
              exit 1
            fi
            if ! "$environment/bin/python" -m pip install pre-commit==4.6.2; then
              echo '::error::Could not install pre-commit 4.6.2; use Python 3.10+ and allow access to PyPI.'
              exit 1
            fi
            mkdir "$environment/commands"
            ln -s "$environment/bin/pre-commit" "$environment/commands/pre-commit"
            echo "$environment/commands" >> "$GITHUB_PATH"
          fi
      - name: Run all hooks and collect fixes
        id: hooks
        shell: bash
        run: |
          # A formatter exits 1 when it edits a file. The final pass below
          # decides whether the configuration is now clean.
          pre-commit run --all-files --show-diff-on-failure || true
      - name: Commit fixes or show the fork patch
        id: fixes
        env:
          SAME_REPOSITORY: \${{ github.event.pull_request.head.repo.full_name == github.repository }}
        shell: bash
        run: |
          git -c core.fsmonitor=false -c core.hooksPath=/dev/null add --update
          if ! git diff --cached --quiet; then
            if [[ "$SAME_REPOSITORY" != true ]]; then
              echo 'Apply this patch to the pull request branch, then push again:'
              git diff --cached --binary
              exit 1
            fi
            git -c user.name='github-actions[bot]' \\
                -c user.email='41898282+github-actions[bot]@users.noreply.github.com' \\
                -c core.hooksPath=/dev/null commit -m 'Apply pre-commit fixes'
            echo 'changed=true' >> "$GITHUB_OUTPUT"
          fi
          echo "sha=$(git rev-parse HEAD)" >> "$GITHUB_OUTPUT"
      - name: Push fixes
        if: \${{ steps.fixes.outputs.changed == 'true' && github.event.pull_request.head.repo.full_name == github.repository }}
        env:
          GH_TOKEN: \${{ github.token }}
          HEAD_BRANCH: \${{ github.event.pull_request.head.ref }}
        run: |
          # Disable repository-configured subprocess hooks while credentials exist.
          authorization=$(printf 'x-access-token:%s' "$GH_TOKEN" | base64 -w0)
          git -c core.fsmonitor=false -c core.hooksPath=/dev/null -c credential.helper= \\
              -c "http.https://github.com/.extraheader=AUTHORIZATION: basic $authorization" \\
              push origin "HEAD:refs/heads/$HEAD_BRANCH"
      - name: Mark the fixing commit pending
        id: fixed-check
        if: \${{ steps.fixes.outputs.changed == 'true' && github.event.pull_request.head.repo.full_name == github.repository }}
        env:
          GH_TOKEN: \${{ github.token }}
          REPOSITORY: \${{ github.repository }}
          CHECKED_SHA: \${{ steps.fixes.outputs.sha }}
          RUN_URL: \${{ github.server_url }}/\${{ github.repository }}/actions/runs/\${{ github.run_id }}
        run: |
          payload=$(node -e 'console.log(JSON.stringify({name: "pre-commit", head_sha: process.env.CHECKED_SHA, status: "in_progress", details_url: process.env.RUN_URL}))')
          response=$(curl --fail-with-body --silent --show-error \\
            -H "Authorization: Bearer $GH_TOKEN" -H "Accept: application/vnd.github+json" \\
            "https://api.github.com/repos/$REPOSITORY/check-runs" --data "$payload")
          check_id=$(node -e 'const id=JSON.parse(process.argv[1]).id; if (!Number.isSafeInteger(id)) process.exit(1); console.log(id)' "$response")
          echo "id=$check_id" >> "$GITHUB_OUTPUT"
      - name: Check the fixed tree in the same job
        id: checks
        # A GITHUB_TOKEN push does not start another workflow run.
        if: \${{ !cancelled() && steps.hooks.outcome == 'success' }}
        run: |
          pre-commit run --all-files --show-diff-on-failure
          git diff --exit-code
          git diff --cached --exit-code
      - name: Publish result on the fixing commit
        if: \${{ always() && steps.fixed-check.outcome == 'success' }}
        env:
          GH_TOKEN: \${{ github.token }}
          REPOSITORY: \${{ github.repository }}
          CHECK_ID: \${{ steps.fixed-check.outputs.id }}
          CHECK_OUTCOME: \${{ steps.checks.outcome }}
          JOB_STATUS: \${{ job.status }}
        run: |
          conclusion=failure
          if [[ "$CHECK_OUTCOME" == success && "$JOB_STATUS" == success ]]; then
            conclusion=success
          fi
          payload=$(node -e 'console.log(JSON.stringify({status: "completed", conclusion: process.argv[1]}))' "$conclusion")
          curl --fail-with-body --silent --show-error --request PATCH \\
            -H "Authorization: Bearer $GH_TOKEN" -H "Accept: application/vnd.github+json" \\
            "https://api.github.com/repos/$REPOSITORY/check-runs/$CHECK_ID" --data "$payload"
`
};

// src/setup/app.ts
var APP_PERMISSIONS = {
  contents: "write",
  pull_requests: "write",
  workflows: "write",
  checks: "read",
  statuses: "read"
};
var APP_DESCRIPTION = "Two-way sync between Linear documents and Markdown in this repository.";
function appCreationUrl(organization) {
  const base = organization === void 0 ? "https://github.com/settings/apps/new" : `https://github.com/organizations/${encodeURIComponent(organization)}/settings/apps/new`;
  const params = new URLSearchParams({
    description: APP_DESCRIPTION,
    url: PROJECT_URL,
    public: "false",
    webhook_active: "false",
    ...APP_PERMISSIONS
  });
  return `${base}?${params.toString()}`;
}

// src/init/command.ts
var INIT_USAGE = `Usage: mdbisync init --release-sha <40-character SHA> [--release-version vX.Y.Z]
  --folder <path> --team <name> [--project <name>]   Repeat for each folder
  --security-hooks | --no-security-hooks           Optional examples (requires Docker)
Existing files and annotations are preserved; conflicting values must be resolved first.
`;
var InitError = class extends Error {
};
function parseArgs(args) {
  const settings = { folders: [] };
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (flag === "--security-hooks" || flag === "--no-security-hooks") {
      if (settings.security !== void 0) throw new InitError("choose security hooks once");
      settings.security = flag === "--security-hooks";
      continue;
    }
    if (!["--release-sha", "--release-version", "--folder", "--team", "--project"].includes(flag ?? "")) throw new InitError(`unknown option: ${flag}`);
    const value = args[++i];
    if (value === void 0 || value.startsWith("--") || !value.trim()) throw new InitError(`${flag} needs a value`);
    if (flag === "--folder") settings.folders.push({ path: value });
    else if (flag === "--team" || flag === "--project") {
      const folder = settings.folders.at(-1);
      if (!folder) throw new InitError(`${flag} must follow --folder`);
      const key = flag === "--team" ? "team" : "project";
      if (folder[key] !== void 0) throw new InitError(`${flag} was given twice for a folder`);
      folder[key] = value.trim();
    } else {
      const key = flag === "--release-sha" ? "sha" : "version";
      if (settings[key] !== void 0) throw new InitError(`${flag} was given twice`);
      settings[key] = value;
    }
  }
  return settings;
}
async function optionalRead(path2) {
  try {
    return await readFile4(path2, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return void 0;
    throw error;
  }
}
async function safePath(root, path2) {
  if (isAbsolute2(path2) || path2.split(/[\\/]/).includes("..") || path2.includes("\\")) throw new InitError("paths must stay inside the repository");
  const target = resolve2(root, path2);
  if (relative2(root, target).startsWith(`..${sep2}`)) throw new InitError("paths must stay inside the repository");
  let part = root;
  for (const component of relative2(root, target).split(sep2).filter(Boolean)) {
    part = join9(part, component);
    try {
      if ((await lstat(part)).isSymbolicLink()) throw new InitError("setup destinations must not contain symlinks");
    } catch (error) {
      if (error.code === "ENOTDIR") throw new InitError("a setup folder path names a regular file");
      if (error.code !== "ENOENT") throw error;
    }
  }
  return target;
}
function document3(text4) {
  const doc = (0, import_yaml3.parseDocument)(text4, { prettyErrors: false });
  if (doc.errors.length || !(0, import_yaml3.isMap)(doc.contents) && doc.contents !== null) throw new InitError("invalid YAML configuration");
  return doc;
}
function annotate(text4, folder) {
  const fm = findFrontMatter(text4);
  const doc = document3(fm?.yaml ?? "");
  let changed2 = false;
  for (const [key, value] of [[TEAM_KEY, folder.team], [PROJECT_KEY, folder.project]]) {
    if (value === void 0) continue;
    if (doc.has(key)) {
      if (doc.get(key) !== value) throw new InitError(`${folder.path}/README.md already has a different ${key}`);
    } else {
      doc.set(key, value);
      changed2 = true;
    }
  }
  if (!changed2) return text4;
  if (fm === null) {
    const bom = text4.startsWith("\uFEFF") ? "\uFEFF" : "";
    const body2 = bom ? text4.slice(1) : text4;
    return `${bom}---
${doc.toString({ lineWidth: 0 })}---
${body2}`;
  }
  const opening = /^﻿?---[^\S\r\n]*\r?\n/.exec(text4)[0];
  const eol = opening.endsWith("\r\n") ? "\r\n" : "\n";
  return opening + doc.toString({ lineWidth: 0 }).replace(/\n/g, eol) + text4.slice(opening.length + fm.yaml.length);
}
var SCANNER_IMAGE = "ghcr.io/gitleaks/gitleaks:v8.30.1@sha256:c00b6bd0aeb3071cbcb79009cb16a60dd9e0a7c60e2be9ab65d25e6bc8abbb7f";
function hookConfig(text4, settings) {
  const doc = document3(text4 ?? "default_install_hook_types: [pre-commit, pre-push]\nrepos: []\n");
  const repos = doc.get("repos");
  if (!(0, import_yaml3.isSeq)(repos)) throw new InitError(`${PRE_COMMIT_CONFIG} needs a repos list`);
  if (text4 === void 0) repos.flow = false;
  const data = doc.toJS();
  if (data.repos.some((repo) => repo === null || typeof repo !== "object" || !Array.isArray(repo.hooks) || repo.hooks.some((hook) => hook === null || typeof hook !== "object" || typeof hook.id !== "string"))) throw new InitError("invalid pre-commit repository entry");
  const existing = data.repos.filter((repo) => repo.hooks?.some((hook) => hook.id === LINEAR_FORMAT_HOOK));
  if (existing.some((repo) => repo.repo !== PROJECT_URL || repo.rev !== settings.sha)) throw new InitError("existing linear-format hook uses a different repository or release");
  let changed2 = text4 === void 0;
  if (!existing.length) {
    repos.add(doc.createNode({ repo: PROJECT_URL, rev: settings.sha, hooks: [{ id: LINEAR_FORMAT_HOOK }] }));
    changed2 = true;
  }
  if (settings.security) {
    const examples = [
      { id: "gitleaks", name: "Scan for secrets (Docker required)", alias: SECURITY_ALIAS, language: "docker_image", entry: `${SCANNER_IMAGE} dir --redact --no-banner .`, pass_filenames: false, stages: ["pre-commit", "pre-push"] },
      { id: "private-key-pattern", name: "Private key pattern", alias: SECURITY_ALIAS, language: "pygrep", entry: "-----BEGIN (?:[A-Z0-9]+ )?PRIVATE KEY-----", args: ["--multiline"], stages: ["pre-commit", "pre-push"] }
    ];
    const hooks = data.repos.flatMap((repo) => repo.hooks ?? []);
    for (const example of examples) {
      const matches = hooks.filter((hook) => hook.id === example.id);
      for (const hook of matches) {
        const local = data.repos.some((repo) => repo.repo === "local" && repo.hooks?.includes(hook));
        if (!local || Object.entries(example).some(([key, value]) => JSON.stringify(hook[key]) !== JSON.stringify(value))) {
          throw new InitError(`existing ${example.id} hook differs from the security example; reconcile it first`);
        }
      }
    }
    const missing = examples.filter((hook) => !hooks.some((existing2) => existing2.id === hook.id));
    if (missing.length) {
      repos.add(doc.createNode({ repo: "local", hooks: missing }));
      changed2 = true;
    }
  }
  return changed2 ? doc.toString({ lineWidth: 0 }) : text4;
}
async function runInit(args, options = {}) {
  if (args.includes("--help") || args.includes("-h")) return { exitCode: 0, stdout: INIT_USAGE, stderr: "" };
  try {
    const settings = parseArgs(args);
    const ask = options.prompt;
    const needsGuidance = !settings.sha || !settings.folders.length || settings.folders.some((folder) => !folder.team && !folder.project);
    if (ask && needsGuidance) {
      settings.sha ??= (await ask("Release commit SHA: ")).trim();
      if (!settings.folders.length) settings.folders.push({ path: (await ask("Folder to synchronize: ")).trim() });
      for (const folder of settings.folders) {
        if (folder.team === void 0) {
          const team = (await ask(`Linear team for ${folder.path} (blank to keep or inherit): `)).trim();
          if (team) folder.team = team;
        }
        if (folder.project === void 0) {
          const project = (await ask(`Linear project for ${folder.path} (blank for team documents): `)).trim();
          if (project) folder.project = project;
        }
      }
      settings.security ??= /^(y|yes)$/i.test((await ask("Include security hook examples (requires Docker)? [y/N] ")).trim());
    }
    if (!/^[a-f0-9]{40}$/.test(settings.sha ?? "")) throw new InitError("--release-sha must be a full 40-character commit SHA");
    if (settings.version !== void 0 && !/^v\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(settings.version)) throw new InitError("--release-version must be a version such as v1.2.3");
    if (!settings.folders.length || settings.folders.some((folder) => !folder.path.trim() || !folder.team && !folder.project)) throw new InitError("provide --folder with --team and/or --project");
    const root = await realpath(options.cwd ?? process.cwd());
    if (!await lstat(join9(root, ".git")).catch(() => void 0)) throw new InitError("run init at the repository root");
    const changes = /* @__PURE__ */ new Map();
    const queue = async (path2, create) => {
      const target = await safePath(root, path2);
      const before = await optionalRead(target);
      const after = create(before);
      if (changes.has(target) && changes.get(target) !== after) throw new InitError(`conflicting folder options: ${path2}`);
      if (before !== after) changes.set(target, after);
    };
    for (const [name, template] of Object.entries(workflows_default)) {
      const content4 = template.replace(/mdbisync\/mdbisync@[a-f0-9]{40} # v[^\s]+/g, `mdbisync/mdbisync@${settings.sha}${settings.version ? ` # ${settings.version}` : ""}`);
      await queue(`.github/workflows/${name}`, (before) => {
        if (before !== void 0 && before !== content4) throw new InitError(`existing workflow differs: ${name}`);
        return content4;
      });
    }
    await queue(PRE_COMMIT_CONFIG, (before) => hookConfig(before, settings));
    for (const folder of settings.folders) await queue(join9(folder.path, ANNOTATION_FILE), (before) => annotate(before ?? "", folder));
    const contents = /* @__PURE__ */ new Map();
    const readmes = /* @__PURE__ */ new Set();
    for (const folder of settings.folders) {
      let path2 = resolve2(root, folder.path);
      for (; ; ) {
        readmes.add(join9(path2, ANNOTATION_FILE));
        if (path2 === root) break;
        path2 = dirname3(path2);
      }
    }
    const visited = /* @__PURE__ */ new Set();
    const descendants = async (folder) => {
      if (visited.has(folder)) return;
      visited.add(folder);
      readmes.add(join9(folder, ANNOTATION_FILE));
      let entries;
      try {
        entries = await readdir(folder, { withFileTypes: true });
      } catch (error) {
        if (error.code === "ENOENT") return;
        throw error;
      }
      for (const entry of entries) {
        if (entry.isDirectory() && ![".git", "node_modules"].includes(entry.name)) await descendants(join9(folder, entry.name));
      }
    };
    for (const folder of settings.folders) await descendants(resolve2(root, folder.path));
    for (const path2 of readmes) {
      await safePath(root, relative2(root, path2));
      const text4 = changes.get(path2) ?? await optionalRead(path2);
      if (text4 === void 0) continue;
      contents.set(relative2(root, path2), text4);
    }
    const { annotations, problems } = collectAnnotations(contents);
    if (problems.length) throw new InitError(problems[0].message);
    const mapping = resolveZones(annotations);
    if (mapping.problems.length) throw new InitError(mapping.problems[0].message);
    for (const [path2, text4] of changes) {
      await mkdir5(dirname3(path2), { recursive: true });
      await writeFile6(path2, text4);
    }
    return { exitCode: 0, stderr: "", stdout: `${changes.size ? `Wrote ${changes.size} repository files.` : "Repository files are already initialized."}

Remaining admin steps:
1. Create a Linear OAuth app with read,write client credentials; set repository secrets MDBISYNC_LINEAR_CLIENT_ID and MDBISYNC_LINEAR_CLIENT_SECRET.
2. Create a GitHub App with contents, pull requests and workflows write, checks and commit statuses read (this link fills them in: ${appCreationUrl()}; for an organization's App see ${QUICKSTART_URL}#github-app), and install it on this repository. Set variable MDBISYNC_APP_CLIENT_ID and secret MDBISYNC_APP_PRIVATE_KEY.
3. Allow merge commits; configure required checks for main.
4. Install Node 24 and pre-commit; run pre-commit install and pre-commit install --hook-type pre-push. Security scanner examples also need Docker.
5. Commit the files, run check, then dispatch initial sync with a direction and confirm unchecked for a dry run. Review its plan before confirming: the target side is overwritten.
` };
  } catch (error) {
    if (!(error instanceof InitError)) throw error;
    return { exitCode: 2, stdout: "", stderr: `init: ${error.message}

${INIT_USAGE}` };
  }
}

// src/cli.ts
function usage() {
  const width = Math.max(...Object.keys(COMMANDS).map((name) => name.length));
  const lines2 = Object.entries(COMMANDS).map(([name, info]) => `  ${name.padEnd(width)}  ${info.summary}`);
  return [
    "Usage: mdbisync <command> [paths...]",
    "",
    "Commands:",
    ...lines2,
    "",
    "init --help lists the repository setup flags.",
    "",
    "Options:",
    "  --version  Print the version",
    "  --help     Print this help",
    "",
    "sync, initial-sync and check read their inputs from MDBISYNC_* environment",
    "variables, for example MDBISYNC_LINEAR_CLIENT_ID for the input linear-client-id.",
    "initial-sync also needs MDBISYNC_DIRECTION (git-to-linear or linear-to-git);",
    "it writes only with MDBISYNC_CONFIRM=true, otherwise it is a dry run.",
    ""
  ].join("\n");
}
async function runCli(args, options = {}) {
  const [first] = args;
  if (first === "--version") {
    return { exitCode: 0, stdout: `${VERSION2}
`, stderr: "" };
  }
  if (first === "--help" || first === "-h") {
    return { exitCode: 0, stdout: usage(), stderr: "" };
  }
  if (first === "init") return runInit(args.slice(1), options);
  if (first === "lint") return runLint(args.slice(1));
  if (first === "fix") return runFix(args.slice(1));
  if (first !== void 0 && isCommandName(first)) {
    if (PREFLIGHT_COMMANDS.includes(first)) {
      return runPreflightCommand(first, options);
    }
    return notImplemented(first);
  }
  const problem = first === void 0 ? "missing command" : `unknown command: ${first}`;
  return { exitCode: USAGE_EXIT_CODE, stdout: "", stderr: `${problem}

${usage()}` };
}
async function runPreflightCommand(command, options) {
  const env = options.env ?? process.env;
  const input = (name) => env[environmentName(name)] ?? "";
  let inputs;
  let initialSync;
  try {
    inputs = readInputs(input, env);
    if (command === "initial-sync") initialSync = readInitialSyncInputs(input);
  } catch (error) {
    if (error instanceof InputError) return { exitCode: USAGE_EXIT_CODE, stdout: "", stderr: `${command}: ${error.message}
` };
    throw error;
  }
  const warnings = [];
  const outcome2 = await runOperation(command, inputs, initialSync, {
    git: new Git(options.cwd ?? process.cwd()),
    warn: (message) => {
      if (options.warn) options.warn(message);
      else warnings.push(`warning: ${message}
`);
    },
    log: options.log ?? (() => {
    }),
    ...options.fetch ? { fetch: options.fetch } : {}
  });
  if (inputs.reportFile !== void 0) await writeRunReport(inputs.reportFile, outcome2);
  const summaryFile = env["GITHUB_STEP_SUMMARY"];
  if (summaryFile) await appendFile(summaryFile, outcome2.summary);
  const stderr = warnings.join("");
  const failure = pullRequestEnding(outcome2);
  if (failure !== null) {
    const exitCode = failure.kind === "setup" ? SETUP_FAILED_EXIT_CODE : failure.kind === "no-state" ? NO_STATE_EXIT_CODE : INCOMPLETE_EXIT_CODE;
    return { exitCode, stdout: outcome2.summary, stderr: `${stderr}${command}: ${failure.message}
` };
  }
  const partial = partialCode(outcome2);
  if (partial !== void 0) {
    return { exitCode: INCOMPLETE_EXIT_CODE, stdout: outcome2.summary, stderr: `${stderr}warning: ${command}: ${PARTIAL} (${partial})
` };
  }
  const stopped = stoppedMessage(outcome2);
  if (stopped !== void 0) return { exitCode: INCOMPLETE_EXIT_CODE, stdout: outcome2.summary, stderr: `${stderr}${stopped}
` };
  if (!outcome2.ok) {
    const exitCode = outcome2.code === "initial-sync-required" || outcome2.code === "initial-pull-request-pending" ? NO_STATE_EXIT_CODE : SETUP_FAILED_EXIT_CODE;
    return { exitCode, stdout: outcome2.summary, stderr: `${stderr}${stoppedBeforeWritingMessage(command, outcome2)}
` };
  }
  if (outcome2.confirmed?.code === "container-cap" || outcome2.sync?.write?.code === "container-cap") {
    return { exitCode: INCOMPLETE_EXIT_CODE, stdout: outcome2.summary, stderr: `${stderr}${command}: stopped before any write (container-cap); reduce additions or check document-cap
` };
  }
  const unfinished = outcome2.confirmed ?? outcome2.reverse;
  if (unfinished !== void 0 && !unfinished.complete) {
    return { exitCode: INCOMPLETE_EXIT_CODE, stdout: outcome2.summary, stderr: `${stderr}${unfinishedMessage(command, unfinished.code)}
` };
  }
  if (!outcome2.notImplemented) return { exitCode: 0, stdout: outcome2.summary, stderr };
  const stub = notImplemented(command);
  return { ...stub, stdout: outcome2.summary, stderr: `${stderr}${stub.stderr}` };
}
function notImplemented(command) {
  return { exitCode: COMMANDS[command].notImplementedExitCode, stdout: "", stderr: `${notImplementedMessage(command)}
` };
}
async function main() {
  const terminal = process.argv[2] === "init" && process.stdin.isTTY && process.stdout.isTTY ? createInterface({ input: process.stdin, output: process.stdout }) : void 0;
  try {
    const result = await runCli(process.argv.slice(2), {
      ...terminal ? { prompt: (question) => terminal.question(question) } : {},
      log: (entry) => {
        process.stderr.write(`${JSON.stringify(entry)}
`);
      },
      warn: (message) => {
        process.stderr.write(`warning: ${message}
`);
      }
    });
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
    process.exitCode = result.exitCode;
  } catch (error) {
    process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}
`);
    process.exitCode = 1;
  } finally {
    terminal?.close();
  }
}
if (Number(process.versions.node.split(".")[0]) < 24) {
  process.stderr.write("mdbisync requires Node 24 or newer; install it before running the hook.\n");
  process.exitCode = USAGE_EXIT_CODE;
} else if (import.meta.main) {
  await main();
}
export {
  runCli,
  usage
};
