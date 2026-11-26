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
    var isAlias = (node) => !!node && typeof node === "object" && node[NODE_TYPE] === ALIAS;
    var isDocument = (node) => !!node && typeof node === "object" && node[NODE_TYPE] === DOC;
    var isMap = (node) => !!node && typeof node === "object" && node[NODE_TYPE] === MAP;
    var isPair = (node) => !!node && typeof node === "object" && node[NODE_TYPE] === PAIR;
    var isScalar = (node) => !!node && typeof node === "object" && node[NODE_TYPE] === SCALAR;
    var isSeq = (node) => !!node && typeof node === "object" && node[NODE_TYPE] === SEQ;
    function isCollection(node) {
      if (node && typeof node === "object")
        switch (node[NODE_TYPE]) {
          case MAP:
          case SEQ:
            return true;
        }
      return false;
    }
    function isNode(node) {
      if (node && typeof node === "object")
        switch (node[NODE_TYPE]) {
          case ALIAS:
          case MAP:
          case SCALAR:
          case SEQ:
            return true;
        }
      return false;
    }
    var hasAnchor = (node) => (isScalar(node) || isCollection(node)) && !!node.anchor;
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
    exports.isMap = isMap;
    exports.isNode = isNode;
    exports.isPair = isPair;
    exports.isScalar = isScalar;
    exports.isSeq = isSeq;
  }
});

// node_modules/yaml/dist/visit.js
var require_visit = __commonJS({
  "node_modules/yaml/dist/visit.js"(exports) {
    "use strict";
    var identity = require_identity();
    var BREAK = /* @__PURE__ */ Symbol("break visit");
    var SKIP = /* @__PURE__ */ Symbol("skip children");
    var REMOVE = /* @__PURE__ */ Symbol("remove node");
    function visit(node, visitor) {
      const visitor_ = initVisitor(visitor);
      if (identity.isDocument(node)) {
        const cd = visit_(null, node.contents, visitor_, Object.freeze([node]));
        if (cd === REMOVE)
          node.contents = null;
      } else
        visit_(null, node, visitor_, Object.freeze([]));
    }
    visit.BREAK = BREAK;
    visit.SKIP = SKIP;
    visit.REMOVE = REMOVE;
    function visit_(key, node, visitor, path) {
      const ctrl = callVisitor(key, node, visitor, path);
      if (identity.isNode(ctrl) || identity.isPair(ctrl)) {
        replaceNode(key, path, ctrl);
        return visit_(key, ctrl, visitor, path);
      }
      if (typeof ctrl !== "symbol") {
        if (identity.isCollection(node)) {
          path = Object.freeze(path.concat(node));
          for (let i = 0; i < node.items.length; ++i) {
            const ci = visit_(i, node.items[i], visitor, path);
            if (typeof ci === "number")
              i = ci - 1;
            else if (ci === BREAK)
              return BREAK;
            else if (ci === REMOVE) {
              node.items.splice(i, 1);
              i -= 1;
            }
          }
        } else if (identity.isPair(node)) {
          path = Object.freeze(path.concat(node));
          const ck = visit_("key", node.key, visitor, path);
          if (ck === BREAK)
            return BREAK;
          else if (ck === REMOVE)
            node.key = null;
          const cv = visit_("value", node.value, visitor, path);
          if (cv === BREAK)
            return BREAK;
          else if (cv === REMOVE)
            node.value = null;
        }
      }
      return ctrl;
    }
    async function visitAsync(node, visitor) {
      const visitor_ = initVisitor(visitor);
      if (identity.isDocument(node)) {
        const cd = await visitAsync_(null, node.contents, visitor_, Object.freeze([node]));
        if (cd === REMOVE)
          node.contents = null;
      } else
        await visitAsync_(null, node, visitor_, Object.freeze([]));
    }
    visitAsync.BREAK = BREAK;
    visitAsync.SKIP = SKIP;
    visitAsync.REMOVE = REMOVE;
    async function visitAsync_(key, node, visitor, path) {
      const ctrl = await callVisitor(key, node, visitor, path);
      if (identity.isNode(ctrl) || identity.isPair(ctrl)) {
        replaceNode(key, path, ctrl);
        return visitAsync_(key, ctrl, visitor, path);
      }
      if (typeof ctrl !== "symbol") {
        if (identity.isCollection(node)) {
          path = Object.freeze(path.concat(node));
          for (let i = 0; i < node.items.length; ++i) {
            const ci = await visitAsync_(i, node.items[i], visitor, path);
            if (typeof ci === "number")
              i = ci - 1;
            else if (ci === BREAK)
              return BREAK;
            else if (ci === REMOVE) {
              node.items.splice(i, 1);
              i -= 1;
            }
          }
        } else if (identity.isPair(node)) {
          path = Object.freeze(path.concat(node));
          const ck = await visitAsync_("key", node.key, visitor, path);
          if (ck === BREAK)
            return BREAK;
          else if (ck === REMOVE)
            node.key = null;
          const cv = await visitAsync_("value", node.value, visitor, path);
          if (cv === BREAK)
            return BREAK;
          else if (cv === REMOVE)
            node.value = null;
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
    function callVisitor(key, node, visitor, path) {
      if (typeof visitor === "function")
        return visitor(key, node, path);
      if (identity.isMap(node))
        return visitor.Map?.(key, node, path);
      if (identity.isSeq(node))
        return visitor.Seq?.(key, node, path);
      if (identity.isPair(node))
        return visitor.Pair?.(key, node, path);
      if (identity.isScalar(node))
        return visitor.Scalar?.(key, node, path);
      if (identity.isAlias(node))
        return visitor.Alias?.(key, node, path);
      return void 0;
    }
    function replaceNode(key, path, node) {
      const parent = path[path.length - 1];
      if (identity.isCollection(parent)) {
        parent.items[key] = node;
      } else if (identity.isPair(parent)) {
        if (key === "key")
          parent.key = node;
        else
          parent.value = node;
      } else if (identity.isDocument(parent)) {
        parent.contents = node;
      } else {
        const pt = identity.isAlias(parent) ? "alias" : "scalar";
        throw new Error(`Cannot replace node with ${pt} parent`);
      }
    }
    exports.visit = visit;
    exports.visitAsync = visitAsync;
  }
});

// node_modules/yaml/dist/doc/directives.js
var require_directives = __commonJS({
  "node_modules/yaml/dist/doc/directives.js"(exports) {
    "use strict";
    var identity = require_identity();
    var visit = require_visit();
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
      add(line, onError) {
        if (this.atNextDocument) {
          this.yaml = { explicit: _Directives.defaultYaml.explicit, version: "1.1" };
          this.tags = Object.assign({}, _Directives.defaultTags);
          this.atNextDocument = false;
        }
        const parts = line.trim().split(/[ \t]+/);
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
        const lines = this.yaml.explicit ? [`%YAML ${this.yaml.version || "1.2"}`] : [];
        const tagEntries = Object.entries(this.tags);
        let tagNames;
        if (doc && tagEntries.length > 0 && identity.isNode(doc.contents)) {
          const tags = {};
          visit.visit(doc.contents, (_key, node) => {
            if (identity.isNode(node) && node.tag)
              tags[node.tag] = true;
          });
          tagNames = Object.keys(tags);
        } else
          tagNames = [];
        for (const [handle, prefix] of tagEntries) {
          if (handle === "!!" && prefix === "tag:yaml.org,2002:")
            continue;
          if (!doc || tagNames.some((tn) => tn.startsWith(prefix)))
            lines.push(`%TAG ${handle} ${prefix}`);
        }
        return lines.join("\n");
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
    var visit = require_visit();
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
      visit.visit(root, {
        Value(_key, node) {
          if (node.anchor)
            anchors.add(node.anchor);
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
          for (const { count, res: res2 } of ctx.anchors.values())
            onAnchor(res2, count);
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
    var visit = require_visit();
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
          visit.visit(doc, {
            Node: (_key, node) => {
              if (identity.isAlias(node) || identity.hasAnchor(node))
                nodes.push(node);
            }
          });
          if (ctx)
            ctx.aliasResolveCache = nodes;
        }
        let found = void 0;
        for (const node of nodes) {
          if (node === this)
            break;
          if (node.anchor === this.source)
            found = node;
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
    function getAliasCount(doc, node, anchors2) {
      if (identity.isAlias(node)) {
        const source = node.resolve(doc);
        const anchor = anchors2 && source && anchors2.get(source);
        return anchor ? anchor.count * anchor.aliasCount : 0;
      } else if (identity.isCollection(node)) {
        let count = 0;
        for (const item of node.items) {
          const c = getAliasCount(doc, item, anchors2);
          if (c > count)
            count = c;
        }
        return count;
      } else if (identity.isPair(node)) {
        const kc = getAliasCount(doc, node.key, anchors2);
        const vc = getAliasCount(doc, node.value, anchors2);
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
          const node2 = new Scalar.Scalar(value);
          if (ref)
            ref.node = node2;
          return node2;
        }
        tagObj = value instanceof Map ? schema[identity.MAP] : Symbol.iterator in Object(value) ? schema[identity.SEQ] : schema[identity.MAP];
      }
      if (onTagObj) {
        onTagObj(tagObj);
        delete ctx.onTagObj;
      }
      const node = tagObj?.createNode ? tagObj.createNode(ctx.schema, value, ctx) : typeof tagObj?.nodeClass?.from === "function" ? tagObj.nodeClass.from(ctx.schema, value, ctx) : new Scalar.Scalar(value);
      if (tagName)
        node.tag = tagName;
      else if (!tagObj.default)
        node.tag = tagObj.tag;
      if (ref)
        ref.node = node;
      return node;
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
    function collectionFromPath(schema, path, value) {
      let v = value;
      for (let i = path.length - 1; i >= 0; --i) {
        const k = path[i];
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
    var isEmptyPath = (path) => path == null || typeof path === "object" && !!path[Symbol.iterator]().next().done;
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
      addIn(path, value) {
        if (isEmptyPath(path))
          this.add(value);
        else {
          const [key, ...rest] = path;
          const node = this.get(key, true);
          if (identity.isCollection(node))
            node.addIn(rest, value);
          else if (node === void 0 && this.schema)
            this.set(key, collectionFromPath(this.schema, rest, value));
          else
            throw new Error(`Expected YAML collection at ${key}. Remaining path: ${rest}`);
        }
      }
      /**
       * Removes a value from the collection.
       * @returns `true` if the item was found and removed.
       */
      deleteIn(path) {
        const [key, ...rest] = path;
        if (rest.length === 0)
          return this.delete(key);
        const node = this.get(key, true);
        if (identity.isCollection(node))
          return node.deleteIn(rest);
        else
          throw new Error(`Expected YAML collection at ${key}. Remaining path: ${rest}`);
      }
      /**
       * Returns item at `key`, or `undefined` if not found. By default unwraps
       * scalar values from their surrounding node; to disable set `keepScalar` to
       * `true` (collections are always returned intact).
       */
      getIn(path, keepScalar) {
        const [key, ...rest] = path;
        const node = this.get(key, true);
        if (rest.length === 0)
          return !keepScalar && identity.isScalar(node) ? node.value : node;
        else
          return identity.isCollection(node) ? node.getIn(rest, keepScalar) : void 0;
      }
      hasAllNullValues(allowScalar) {
        return this.items.every((node) => {
          if (!identity.isPair(node))
            return false;
          const n = node.value;
          return n == null || allowScalar && identity.isScalar(n) && n.value == null && !n.commentBefore && !n.comment && !n.tag;
        });
      }
      /**
       * Checks if the collection includes a value with the key `key`.
       */
      hasIn(path) {
        const [key, ...rest] = path;
        if (rest.length === 0)
          return this.has(key);
        const node = this.get(key, true);
        return identity.isCollection(node) ? node.hasIn(rest) : false;
      }
      /**
       * Sets a value in this collection. For `!!set`, `value` needs to be a
       * boolean to add/remove the item from the set.
       */
      setIn(path, value) {
        const [key, ...rest] = path;
        if (rest.length === 0) {
          this.set(key, value);
        } else {
          const node = this.get(key, true);
          if (identity.isCollection(node))
            node.setIn(rest, value);
          else if (node === void 0 && this.schema)
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
    function indentComment(comment, indent) {
      if (/^\n+$/.test(comment))
        return comment.substring(1);
      return indent ? comment.replace(/^(?! *$)/gm, indent) : comment;
    }
    var lineComment = (str, indent, comment) => str.endsWith("\n") ? indentComment(comment, indent) : comment.includes("\n") ? "\n" + indentComment(comment, indent) : (str.endsWith(" ") ? "" : " ") + comment;
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
    function foldFlowLines(text, indent, mode = "flow", { indentAtStart, lineWidth = 80, minContentWidth = 20, onFold, onOverflow } = {}) {
      if (!lineWidth || lineWidth < 0)
        return text;
      if (lineWidth < minContentWidth)
        minContentWidth = 0;
      const endStep = Math.max(1 + minContentWidth, 1 + lineWidth - indent.length);
      if (text.length <= endStep)
        return text;
      const folds = [];
      const escapedFolds = {};
      let end = lineWidth - indent.length;
      if (typeof indentAtStart === "number") {
        if (indentAtStart > lineWidth - Math.max(2, minContentWidth))
          folds.push(0);
        else
          end = lineWidth - indentAtStart;
      }
      let split = void 0;
      let prev = void 0;
      let overflow = false;
      let i = -1;
      let escStart = -1;
      let escEnd = -1;
      if (mode === FOLD_BLOCK) {
        i = consumeMoreIndentedLines(text, i, indent.length);
        if (i !== -1)
          end = i + endStep;
      }
      for (let ch; ch = text[i += 1]; ) {
        if (mode === FOLD_QUOTED && ch === "\\") {
          escStart = i;
          switch (text[i + 1]) {
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
            i = consumeMoreIndentedLines(text, i, indent.length);
          end = i + indent.length + endStep;
          split = void 0;
        } else {
          if (ch === " " && prev && prev !== " " && prev !== "\n" && prev !== "	") {
            const next = text[i + 1];
            if (next && next !== " " && next !== "\n" && next !== "	")
              split = i;
          }
          if (i >= end) {
            if (split) {
              folds.push(split);
              end = split + endStep;
              split = void 0;
            } else if (mode === FOLD_QUOTED) {
              while (prev === " " || prev === "	") {
                prev = ch;
                ch = text[i += 1];
                overflow = true;
              }
              const j = i > escEnd + 1 ? i - 2 : escStart - 1;
              if (escapedFolds[j])
                return text;
              folds.push(j);
              escapedFolds[j] = true;
              end = j + endStep;
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
        return text;
      if (onFold)
        onFold();
      let res = text.slice(0, folds[0]);
      for (let i2 = 0; i2 < folds.length; ++i2) {
        const fold = folds[i2];
        const end2 = folds[i2 + 1] || text.length;
        if (fold === 0)
          res = `
${indent}${text.slice(0, end2)}`;
        else {
          if (mode === FOLD_QUOTED && escapedFolds[fold])
            res += `${text[fold]}\\`;
          res += `
${indent}${text.slice(fold + 1, end2)}`;
        }
      }
      return res;
    }
    function consumeMoreIndentedLines(text, i, indent) {
      let end = i;
      let start2 = i + 1;
      let ch = text[start2];
      while (ch === " " || ch === "	") {
        if (i < start2 + indent) {
          ch = text[++i];
        } else {
          do {
            ch = text[++i];
          } while (ch && ch !== "\n");
          end = i;
          start2 = i + 1;
          ch = text[start2];
        }
      }
      return end;
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
      const indent = ctx.indent || (containsDocumentMarker(value) ? "  " : "");
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
                const code = json.substr(i + 2, 4);
                switch (code) {
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
                    if (code.substr(0, 2) === "00")
                      str += "\\x" + code.substr(2);
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
                str += indent;
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
      return implicitKey ? str : foldFlowLines.foldFlowLines(str, indent, foldFlowLines.FOLD_QUOTED, getFoldOptions(ctx, false));
    }
    function singleQuotedString(value, ctx) {
      if (ctx.options.singleQuote === false || ctx.implicitKey && value.includes("\n") || /[ \t]\n|\n[ \t]/.test(value))
        return doubleQuotedString(value, ctx);
      const indent = ctx.indent || (containsDocumentMarker(value) ? "  " : "");
      const res = "'" + value.replace(/'/g, "''").replace(/\n+/g, `$&
${indent}`) + "'";
      return ctx.implicitKey ? res : foldFlowLines.foldFlowLines(res, indent, foldFlowLines.FOLD_FLOW, getFoldOptions(ctx, false));
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
      const { blockQuote, commentString, lineWidth } = ctx.options;
      if (!blockQuote || /\n[\t ]+$/.test(value)) {
        return quotedString(value, ctx);
      }
      const indent = ctx.indent || (ctx.forceBlockIndent || containsDocumentMarker(value) ? "  " : "");
      const literal = blockQuote === "literal" ? true : blockQuote === "folded" || type === Scalar.Scalar.BLOCK_FOLDED ? false : type === Scalar.Scalar.BLOCK_LITERAL ? true : !lineLengthOverLimit(value, lineWidth, indent.length);
      if (!value)
        return literal ? "|\n" : ">\n";
      let chomp;
      let endStart;
      for (endStart = value.length; endStart > 0; --endStart) {
        const ch = value[endStart - 1];
        if (ch !== "\n" && ch !== "	" && ch !== " ")
          break;
      }
      let end = value.substring(endStart);
      const endNlPos = end.indexOf("\n");
      if (endNlPos === -1) {
        chomp = "-";
      } else if (value === end || endNlPos !== end.length - 1) {
        chomp = "+";
        if (onChompKeep)
          onChompKeep();
      } else {
        chomp = "";
      }
      if (end) {
        value = value.slice(0, -end.length);
        if (end[end.length - 1] === "\n")
          end = end.slice(0, -1);
        end = end.replace(blockEndNewlines, `$&${indent}`);
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
        start2 = start2.replace(/\n+/g, `$&${indent}`);
      }
      const indentSize = indent ? "2" : "1";
      let header = (startWithSpace ? indentSize : "") + chomp;
      if (comment) {
        header += " " + commentString(comment.replace(/ ?[\r\n]+/g, " "));
        if (onComment)
          onComment();
      }
      if (!literal) {
        const foldedValue = value.replace(/\n+/g, "\n$&").replace(/(?:^|\n)([\t ].*)(?:([\n\t ]*)\n(?![\n\t ]))?/g, "$1$2").replace(/\n+/g, `$&${indent}`);
        let literalFallback = false;
        const foldOptions = getFoldOptions(ctx, true);
        if (blockQuote !== "folded" && type !== Scalar.Scalar.BLOCK_FOLDED) {
          foldOptions.onOverflow = () => {
            literalFallback = true;
          };
        }
        const body = foldFlowLines.foldFlowLines(`${start2}${foldedValue}${end}`, indent, foldFlowLines.FOLD_BLOCK, foldOptions);
        if (!literalFallback)
          return `>${header}
${indent}${body}`;
      }
      value = value.replace(/\n+/g, `$&${indent}`);
      return `|${header}
${indent}${start2}${value}${end}`;
    }
    function plainString(item, ctx, onComment, onChompKeep) {
      const { type, value } = item;
      const { actualString, implicitKey, indent, indentStep, inFlow } = ctx;
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
        if (indent === "") {
          ctx.forceBlockIndent = true;
          return blockString(item, ctx, onComment, onChompKeep);
        } else if (implicitKey && indent === indentStep) {
          return quotedString(value, ctx);
        }
      }
      const str = value.replace(/\n+/g, `$&
${indent}`);
      if (actualString) {
        const test = (tag) => tag.default && tag.tag !== "tag:yaml.org,2002:str" && tag.test?.test(str);
        const { compat, tags } = ctx.doc.schema;
        if (tags.some(test) || compat?.some(test))
          return quotedString(value, ctx);
      }
      return implicitKey ? str : foldFlowLines.foldFlowLines(str, indent, foldFlowLines.FOLD_FLOW, getFoldOptions(ctx, false));
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
    function stringifyProps(node, tagObj, { anchors: anchors$1, doc }) {
      if (!doc.directives)
        return "";
      const props = [];
      const anchor = (identity.isScalar(node) || identity.isCollection(node)) && node.anchor;
      if (anchor && anchors.anchorIsValid(anchor)) {
        anchors$1.add(anchor);
        props.push(`&${anchor}`);
      }
      const tag = node.tag ?? (tagObj.default ? null : tagObj.tag);
      if (tag)
        props.push(doc.directives.tagString(tag));
      return props.join(" ");
    }
    function stringify(item, ctx, onComment, onChompKeep) {
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
      const node = identity.isNode(item) ? item : ctx.doc.createNode(item, { onTagObj: (o) => tagObj = o });
      tagObj ?? (tagObj = getTagObject(ctx.doc.schema.tags, node));
      const props = stringifyProps(node, tagObj, ctx);
      if (props.length > 0)
        ctx.indentAtStart = (ctx.indentAtStart ?? 0) + props.length + 1;
      const str = typeof tagObj.stringify === "function" ? tagObj.stringify(node, ctx, onComment, onChompKeep) : identity.isScalar(node) ? stringifyString.stringifyString(node, ctx, onComment, onChompKeep) : node.toString(ctx, onComment, onChompKeep);
      if (!props)
        return str;
      return identity.isScalar(node) || str[0] === "{" || str[0] === "[" ? `${props} ${str}` : `${props}
${ctx.indent}${str}`;
    }
    exports.createStringifyContext = createStringifyContext;
    exports.stringify = stringify;
  }
});

// node_modules/yaml/dist/stringify/stringifyPair.js
var require_stringifyPair = __commonJS({
  "node_modules/yaml/dist/stringify/stringifyPair.js"(exports) {
    "use strict";
    var identity = require_identity();
    var Scalar = require_Scalar();
    var stringify = require_stringify();
    var stringifyComment = require_stringifyComment();
    function stringifyPair({ key, value }, ctx, onComment, onChompKeep) {
      const { allNullValues, doc, indent, indentStep, options: { commentString, indentSeq, simpleKeys } } = ctx;
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
        indent: indent + indentStep
      });
      let keyCommentDone = false;
      let chompKeep = false;
      let str = stringify.stringify(key, ctx, () => keyCommentDone = true, () => chompKeep = true);
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
${indent}:`;
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
      const valueStr = stringify.stringify(value, ctx, () => valueCommentDone = true, () => chompKeep = true);
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
        const flow = ctx.inFlow ?? value.flow ?? value.items.length === 0;
        if (hasNewline || !flow) {
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
    function warn(logLevel, warning2) {
      if (logLevel === "debug" || logLevel === "warn") {
        if (typeof node_process.emitWarning === "function")
          node_process.emitWarning(warning2);
        else
          console.warn(warning2);
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
    var stringify = require_stringify();
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
        const strCtx = stringify.createStringifyContext(ctx.doc, {});
        strCtx.anchors = /* @__PURE__ */ new Set();
        for (const node of ctx.anchors.keys())
          strCtx.anchors.add(node.anchor);
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
    var stringify = require_stringify();
    var stringifyComment = require_stringifyComment();
    function stringifyCollection(collection, ctx, options) {
      const flow = ctx.inFlow ?? collection.flow;
      const stringify2 = flow ? stringifyFlowCollection : stringifyBlockCollection;
      return stringify2(collection, ctx, options);
    }
    function stringifyBlockCollection({ comment, items }, ctx, { blockItemPrefix, flowChars, itemIndent, onChompKeep, onComment }) {
      const { indent, options: { commentString } } = ctx;
      const itemCtx = Object.assign({}, ctx, { indent: itemIndent, type: null });
      let chompKeep = false;
      const lines = [];
      for (let i = 0; i < items.length; ++i) {
        const item = items[i];
        let comment2 = null;
        if (identity.isNode(item)) {
          if (!chompKeep && item.spaceBefore)
            lines.push("");
          addCommentBefore(ctx, lines, item.commentBefore, chompKeep);
          if (item.comment)
            comment2 = item.comment;
        } else if (identity.isPair(item)) {
          const ik = identity.isNode(item.key) ? item.key : null;
          if (ik) {
            if (!chompKeep && ik.spaceBefore)
              lines.push("");
            addCommentBefore(ctx, lines, ik.commentBefore, chompKeep);
          }
        }
        chompKeep = false;
        let str2 = stringify.stringify(item, itemCtx, () => comment2 = null, () => chompKeep = true);
        if (comment2)
          str2 += stringifyComment.lineComment(str2, itemIndent, commentString(comment2));
        if (chompKeep && comment2)
          chompKeep = false;
        lines.push(blockItemPrefix + str2);
      }
      let str;
      if (lines.length === 0) {
        str = flowChars.start + flowChars.end;
      } else {
        str = lines[0];
        for (let i = 1; i < lines.length; ++i) {
          const line = lines[i];
          str += line ? `
${indent}${line}` : "\n";
        }
      }
      if (comment) {
        str += "\n" + stringifyComment.indentComment(commentString(comment), indent);
        if (onComment)
          onComment();
      } else if (chompKeep && onChompKeep)
        onChompKeep();
      return str;
    }
    function stringifyFlowCollection({ items }, ctx, { flowChars, itemIndent }) {
      const { indent, indentStep, flowCollectionPadding: fcPadding, options: { commentString } } = ctx;
      itemIndent += indentStep;
      const itemCtx = Object.assign({}, ctx, {
        indent: itemIndent,
        inFlow: true,
        type: null
      });
      let reqNewline = false;
      let linesAtValue = 0;
      const lines = [];
      for (let i = 0; i < items.length; ++i) {
        const item = items[i];
        let comment = null;
        if (identity.isNode(item)) {
          if (item.spaceBefore)
            lines.push("");
          addCommentBefore(ctx, lines, item.commentBefore, false);
          if (item.comment)
            comment = item.comment;
        } else if (identity.isPair(item)) {
          const ik = identity.isNode(item.key) ? item.key : null;
          if (ik) {
            if (ik.spaceBefore)
              lines.push("");
            addCommentBefore(ctx, lines, ik.commentBefore, false);
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
        let str = stringify.stringify(item, itemCtx, () => comment = null);
        reqNewline || (reqNewline = lines.length > linesAtValue || str.includes("\n"));
        if (i < items.length - 1) {
          str += ",";
        } else if (ctx.options.trailingComma) {
          if (ctx.options.lineWidth > 0) {
            reqNewline || (reqNewline = lines.reduce((sum, line) => sum + line.length + 2, 2) + (str.length + 2) > ctx.options.lineWidth);
          }
          if (reqNewline) {
            str += ",";
          }
        }
        if (comment)
          str += stringifyComment.lineComment(str, itemIndent, commentString(comment));
        lines.push(str);
        linesAtValue = lines.length;
      }
      const { start: start2, end } = flowChars;
      if (lines.length === 0) {
        return start2 + end;
      } else {
        if (!reqNewline) {
          const len = lines.reduce((sum, line) => sum + line.length + 2, 2);
          reqNewline = ctx.options.lineWidth > 0 && len > ctx.options.lineWidth;
        }
        if (reqNewline) {
          let str = start2;
          for (const line of lines)
            str += line ? `
${indentStep}${indent}${line}` : "\n";
          return `${str}
${indent}${end}`;
        } else {
          return `${start2}${fcPadding}${lines.join(" ")}${fcPadding}${end}`;
        }
      }
    }
    function addCommentBefore({ indent, options: { commentString } }, lines, comment, chompKeep) {
      if (comment && chompKeep)
        comment = comment.replace(/^\n+/, "");
      if (comment) {
        const ic = stringifyComment.indentComment(commentString(comment), indent);
        lines.push(ic.trimStart());
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
        const node = it?.value;
        return (!keepScalar && identity.isScalar(node) ? node.value : node) ?? void 0;
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
    var string = {
      identify: (value) => typeof value === "string",
      default: true,
      tag: "tag:yaml.org,2002:str",
      resolve: (str) => str,
      stringify(item, ctx, onComment, onChompKeep) {
        ctx = Object.assign({ actualString: true }, ctx);
        return stringifyString.stringifyString(item, ctx, onComment, onChompKeep);
      }
    };
    exports.string = string;
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
      stringify(node) {
        const num = Number(node.value);
        return isFinite(num) ? num.toExponential() : stringifyNumber.stringifyNumber(node);
      }
    };
    var float = {
      identify: (value) => typeof value === "number",
      default: true,
      tag: "tag:yaml.org,2002:float",
      test: /^[-+]?(?:\.[0-9]+|[0-9]+\.[0-9]*)$/,
      resolve(str) {
        const node = new Scalar.Scalar(parseFloat(str));
        const dot = str.indexOf(".");
        if (dot !== -1 && str[str.length - 1] === "0")
          node.minFractionDigits = str.length - dot - 1;
        return node;
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
    function intStringify(node, radix, prefix) {
      const { value } = node;
      if (intIdentify(value) && value >= 0)
        return prefix + value.toString(radix);
      return stringifyNumber.stringifyNumber(node);
    }
    var intOct = {
      identify: (value) => intIdentify(value) && value >= 0,
      default: true,
      tag: "tag:yaml.org,2002:int",
      format: "OCT",
      test: /^0o[0-7]+$/,
      resolve: (str, _onError, opt) => intResolve(str, 2, 8, opt),
      stringify: (node) => intStringify(node, 8, "0o")
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
      stringify: (node) => intStringify(node, 16, "0x")
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
    var string = require_string();
    var bool = require_bool();
    var float = require_float();
    var int = require_int();
    var schema = [
      map.map,
      seq.seq,
      string.string,
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
          const lines = new Array(n);
          for (let i = 0, o = 0; i < n; ++i, o += lineWidth) {
            lines[i] = str.substr(o, lineWidth);
          }
          str = lines.join(type === Scalar.Scalar.BLOCK_LITERAL ? "\n" : " ");
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
      stringify(node) {
        const num = Number(node.value);
        return isFinite(num) ? num.toExponential() : stringifyNumber.stringifyNumber(node);
      }
    };
    var float = {
      identify: (value) => typeof value === "number",
      default: true,
      tag: "tag:yaml.org,2002:float",
      test: /^[-+]?(?:[0-9][0-9_]*)?\.[0-9_]*$/,
      resolve(str) {
        const node = new Scalar.Scalar(parseFloat(str.replace(/_/g, "")));
        const dot = str.indexOf(".");
        if (dot !== -1) {
          const f = str.substring(dot + 1).replace(/_/g, "");
          if (f[f.length - 1] === "0")
            node.minFractionDigits = f.length;
        }
        return node;
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
    function intStringify(node, radix, prefix) {
      const { value } = node;
      if (intIdentify(value)) {
        const str = value.toString(radix);
        return value < 0 ? "-" + prefix + str.substr(1) : prefix + str;
      }
      return stringifyNumber.stringifyNumber(node);
    }
    var intBin = {
      identify: intIdentify,
      default: true,
      tag: "tag:yaml.org,2002:int",
      format: "BIN",
      test: /^[-+]?0b[0-1_]+$/,
      resolve: (str, _onError, opt) => intResolve(str, 2, 2, opt),
      stringify: (node) => intStringify(node, 2, "0b")
    };
    var intOct = {
      identify: intIdentify,
      default: true,
      tag: "tag:yaml.org,2002:int",
      format: "OCT",
      test: /^[-+]?0[0-7_]+$/,
      resolve: (str, _onError, opt) => intResolve(str, 1, 8, opt),
      stringify: (node) => intStringify(node, 8, "0")
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
      stringify: (node) => intStringify(node, 16, "0x")
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
    function stringifySexagesimal(node) {
      let { value } = node;
      let num = (n) => n;
      if (typeof value === "bigint")
        num = (n) => BigInt(n);
      else if (isNaN(value) || !isFinite(value))
        return stringifyNumber.stringifyNumber(node);
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
    var string = require_string();
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
      string.string,
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
    var string = require_string();
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
      ["failsafe", [map.map, seq.seq, string.string]],
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
    var string = require_string();
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
        Object.defineProperty(this, identity.SCALAR, { value: string.string });
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
    var stringify = require_stringify();
    var stringifyComment = require_stringifyComment();
    function stringifyDocument(doc, options) {
      const lines = [];
      let hasDirectives = options.directives === true;
      if (options.directives !== false && doc.directives) {
        const dir = doc.directives.toString(doc);
        if (dir) {
          lines.push(dir);
          hasDirectives = true;
        } else if (doc.directives.docStart)
          hasDirectives = true;
      }
      if (hasDirectives)
        lines.push("---");
      const ctx = stringify.createStringifyContext(doc, options);
      const { commentString } = ctx.options;
      if (doc.commentBefore) {
        if (lines.length !== 1)
          lines.unshift("");
        const cs = commentString(doc.commentBefore);
        lines.unshift(stringifyComment.indentComment(cs, ""));
      }
      let chompKeep = false;
      let contentComment = null;
      if (doc.contents) {
        if (identity.isNode(doc.contents)) {
          if (doc.contents.spaceBefore && hasDirectives)
            lines.push("");
          if (doc.contents.commentBefore) {
            const cs = commentString(doc.contents.commentBefore);
            lines.push(stringifyComment.indentComment(cs, ""));
          }
          ctx.forceBlockIndent = !!doc.comment;
          contentComment = doc.contents.comment;
        }
        const onChompKeep = contentComment ? void 0 : () => chompKeep = true;
        let body = stringify.stringify(doc.contents, ctx, () => contentComment = null, onChompKeep);
        if (contentComment)
          body += stringifyComment.lineComment(body, "", commentString(contentComment));
        if ((body[0] === "|" || body[0] === ">") && lines[lines.length - 1] === "---") {
          lines[lines.length - 1] = `--- ${body}`;
        } else
          lines.push(body);
      } else {
        lines.push(stringify.stringify(doc.contents, ctx));
      }
      if (doc.directives?.docEnd) {
        if (doc.comment) {
          const cs = commentString(doc.comment);
          if (cs.includes("\n")) {
            lines.push("...");
            lines.push(stringifyComment.indentComment(cs, ""));
          } else {
            lines.push(`... ${cs}`);
          }
        } else {
          lines.push("...");
        }
      } else {
        let dc = doc.comment;
        if (dc && chompKeep)
          dc = dc.replace(/^\n+/, "");
        if (dc) {
          if ((!chompKeep || contentComment) && lines[lines.length - 1] !== "")
            lines.push("");
          lines.push(stringifyComment.indentComment(commentString(dc), ""));
        }
      }
      return lines.join("\n") + "\n";
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
      addIn(path, value) {
        if (assertCollection(this.contents))
          this.contents.addIn(path, value);
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
      createAlias(node, name) {
        if (!node.anchor) {
          const prev = anchors.anchorNames(this);
          node.anchor = // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing
          !name || prev.has(name) ? anchors.findNewAnchor(name || "a", prev) : name;
        }
        return new Alias.Alias(node.anchor);
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
        const { aliasDuplicateObjects, anchorPrefix, flow, keepUndefined, onTagObj, tag } = options ?? {};
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
        const node = createNode.createNode(value, tag, ctx);
        if (flow && identity.isCollection(node))
          node.flow = true;
        setAnchors();
        return node;
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
      deleteIn(path) {
        if (Collection.isEmptyPath(path)) {
          if (this.contents == null)
            return false;
          this.contents = null;
          return true;
        }
        return assertCollection(this.contents) ? this.contents.deleteIn(path) : false;
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
      getIn(path, keepScalar) {
        if (Collection.isEmptyPath(path))
          return !keepScalar && identity.isScalar(this.contents) ? this.contents.value : this.contents;
        return identity.isCollection(this.contents) ? this.contents.getIn(path, keepScalar) : void 0;
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
      hasIn(path) {
        if (Collection.isEmptyPath(path))
          return this.contents !== void 0;
        return identity.isCollection(this.contents) ? this.contents.hasIn(path) : false;
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
      setIn(path, value) {
        if (Collection.isEmptyPath(path)) {
          this.contents = value;
        } else if (this.contents == null) {
          this.contents = Collection.collectionFromPath(this.schema, Array.from(path), value);
        } else if (assertCollection(this.contents)) {
          this.contents.setIn(path, value);
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
          for (const { count, res: res2 } of ctx.anchors.values())
            onAnchor(res2, count);
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
      constructor(name, pos, code, message2) {
        super();
        this.name = name;
        this.code = code;
        this.message = message2;
        this.pos = pos;
      }
    };
    var YAMLParseError = class extends YAMLError {
      constructor(pos, code, message2) {
        super("YAMLParseError", pos, code, message2);
      }
    };
    var YAMLWarning = class extends YAMLError {
      constructor(pos, code, message2) {
        super("YAMLWarning", pos, code, message2);
      }
    };
    var prettifyError = (src, lc) => (error) => {
      if (error.pos[0] === -1)
        return;
      error.linePos = error.pos.map((pos) => lc.linePos(pos));
      const { line, col } = error.linePos[0];
      error.message += ` at line ${line}, column ${col}`;
      let ci = col - 1;
      let lineStr = src.substring(lc.lineStarts[line - 1], lc.lineStarts[line]).replace(/[\n\r]+$/, "");
      if (ci >= 60 && lineStr.length > 80) {
        const trimStart = Math.min(ci - 39, lineStr.length - 79);
        lineStr = "\u2026" + lineStr.substring(trimStart);
        ci -= trimStart - 1;
      }
      if (lineStr.length > 80)
        lineStr = lineStr.substring(0, 79) + "\u2026";
      if (line > 1 && /^ *$/.test(lineStr.substring(0, ci))) {
        let prev = src.substring(lc.lineStarts[line - 2], lc.lineStarts[line - 1]);
        if (prev.length > 80)
          prev = prev.substring(0, 79) + "\u2026\n";
        lineStr = prev + lineStr;
      }
      if (/[^ ]/.test(lineStr)) {
        let count = 1;
        const end = error.linePos[1];
        if (end?.line === line && end.col > col) {
          count = Math.max(1, Math.min(end.col - col, 80 - ci));
        }
        const pointer = " ".repeat(ci) + "^".repeat(count);
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
    function resolveProps(tokens, { flow, indicator, next, offset, onError, parentIndent, startOnNewline }) {
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
            if (!flow && (indicator !== "doc-start" || next?.type !== "flow-collection") && token.source.includes("	")) {
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
              onError(token, "UNEXPECTED_TOKEN", `Unexpected ${token.source} in ${flow ?? "collection"}`);
            found = token;
            atNewline = indicator === "seq-item-ind" || indicator === "explicit-key-ind";
            hasSpace = false;
            break;
          case "comma":
            if (flow) {
              if (comma)
                onError(token, "UNEXPECTED_TOKEN", `Unexpected , in ${flow}`);
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
      const end = last ? last.offset + last.source.length : offset;
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
        end,
        start: start2 ?? end
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
    function flowIndentCheck(indent, fc, onError) {
      if (fc?.type === "flow-collection") {
        const end = fc.end[0];
        if (end.indent === indent && (end.source === "]" || end.source === "}") && utilContainsNewline.containsNewline(fc)) {
          const msg = "Flow end indicator should be more indented than parent";
          onError(end, "BAD_INDENT", msg, true);
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
    function mapIncludes(ctx, items, search) {
      const { uniqueKeys } = ctx.options;
      if (uniqueKeys === false)
        return false;
      const isEqual = typeof uniqueKeys === "function" ? uniqueKeys : (a, b) => a === b || identity.isScalar(a) && identity.isScalar(b) && a.value === b.value;
      return items.some((pair) => isEqual(pair.key, search));
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
        const { start: start2, key, sep: sep2, value } = collItem;
        const keyProps = resolveProps.resolveProps(start2, {
          indicator: "explicit-key-ind",
          next: key ?? sep2?.[0],
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
          if (!keyProps.anchor && !keyProps.tag && !sep2) {
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
        const valueProps = resolveProps.resolveProps(sep2 ?? [], {
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
          const valueNode = value ? composeNode(ctx, value, valueProps, onError) : composeEmptyNode(ctx, offset, sep2, null, valueProps, onError);
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
        const node = value ? composeNode(ctx, value, props, onError) : composeEmptyNode(ctx, props.end, start2, null, props, onError);
        if (ctx.schema.compat)
          utilFlowIndentCheck.flowIndentCheck(bs.indent, value, onError);
        offset = node.range[2];
        seq.items.push(node);
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
    function resolveEnd(end, offset, reqSpace, onError) {
      let comment = "";
      if (end) {
        let hasSpace = false;
        let sep2 = "";
        for (const token of end) {
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
                comment += sep2 + cb;
              sep2 = "";
              break;
            }
            case "newline":
              if (comment)
                sep2 += source;
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
      const isMap = fc.start.source === "{";
      const fcName = isMap ? "flow map" : "flow sequence";
      const NodeClass = tag?.nodeClass ?? (isMap ? YAMLMap.YAMLMap : YAMLSeq.YAMLSeq);
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
        const { start: start2, key, sep: sep2, value } = collItem;
        const props = resolveProps.resolveProps(start2, {
          flow: fcName,
          indicator: "explicit-key-ind",
          next: key ?? sep2?.[0],
          offset,
          onError,
          parentIndent: fc.indent,
          startOnNewline: false
        });
        if (!props.found) {
          if (!props.anchor && !props.tag && !sep2 && !value) {
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
          if (!isMap && ctx.options.strict && utilContainsNewline.containsNewline(key))
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
        if (!isMap && !sep2 && !props.found) {
          const valueNode = value ? composeNode(ctx, value, props, onError) : composeEmptyNode(ctx, props.end, sep2, null, props, onError);
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
          const valueProps = resolveProps.resolveProps(sep2 ?? [], {
            flow: fcName,
            indicator: "map-value-ind",
            next: value,
            offset: keyNode.range[2],
            onError,
            parentIndent: fc.indent,
            startOnNewline: false
          });
          if (valueProps.found) {
            if (!isMap && !props.found && ctx.options.strict) {
              if (sep2)
                for (const st of sep2) {
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
          const valueNode = value ? composeNode(ctx, value, valueProps, onError) : valueProps.found ? composeEmptyNode(ctx, valueProps.end, sep2, null, valueProps, onError) : null;
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
          if (isMap) {
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
      const expectedEnd = isMap ? "}" : "]";
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
        const end = resolveEnd.resolveEnd(ee, cePos, ctx.options.strict, onError);
        if (end.comment) {
          if (coll.comment)
            coll.comment += "\n" + end.comment;
          else
            coll.comment = end.comment;
        }
        coll.range = [fc.offset, cePos, end.offset];
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
          const message2 = "Missing newline after block sequence props";
          onError(lastProp, "MISSING_CHAR", message2);
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
      const node = identity.isNode(res) ? res : new Scalar.Scalar(res);
      node.range = coll.range;
      node.tag = tagName;
      if (tag?.format)
        node.format = tag.format;
      return node;
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
      const lines = scalar.source ? splitLines(scalar.source) : [];
      let chompStart = lines.length;
      for (let i = lines.length - 1; i >= 0; --i) {
        const content = lines[i][1];
        if (content === "" || content === "\r")
          chompStart = i;
        else
          break;
      }
      if (chompStart === 0) {
        const value2 = header.chomp === "+" && lines.length > 0 ? "\n".repeat(Math.max(1, lines.length - 1)) : "";
        let end2 = start2 + header.length;
        if (scalar.source)
          end2 += scalar.source.length;
        return { value: value2, type, comment: header.comment, range: [start2, end2, end2] };
      }
      let trimIndent = scalar.indent + header.indent;
      let offset = scalar.offset + header.length;
      let contentStart = 0;
      for (let i = 0; i < chompStart; ++i) {
        const [indent, content] = lines[i];
        if (content === "" || content === "\r") {
          if (header.indent === 0 && indent.length > trimIndent)
            trimIndent = indent.length;
        } else {
          if (indent.length < trimIndent) {
            const message2 = "Block scalars with more-indented leading empty lines must use an explicit indentation indicator";
            onError(offset + indent.length, "MISSING_CHAR", message2);
          }
          if (header.indent === 0)
            trimIndent = indent.length;
          contentStart = i;
          if (trimIndent === 0 && !ctx.atRoot) {
            const message2 = "Block scalar values in collections must be indented";
            onError(offset, "BAD_INDENT", message2);
          }
          break;
        }
        offset += indent.length + content.length + 1;
      }
      for (let i = lines.length - 1; i >= chompStart; --i) {
        if (lines[i][0].length > trimIndent)
          chompStart = i + 1;
      }
      let value = "";
      let sep2 = "";
      let prevMoreIndented = false;
      for (let i = 0; i < contentStart; ++i)
        value += lines[i][0].slice(trimIndent) + "\n";
      for (let i = contentStart; i < chompStart; ++i) {
        let [indent, content] = lines[i];
        offset += indent.length + content.length + 1;
        const crlf = content[content.length - 1] === "\r";
        if (crlf)
          content = content.slice(0, -1);
        if (content && indent.length < trimIndent) {
          const src = header.indent ? "explicit indentation indicator" : "first line";
          const message2 = `Block scalar lines must not be less indented than their ${src}`;
          onError(offset - content.length - (crlf ? 2 : 1), "BAD_INDENT", message2);
          indent = "";
        }
        if (type === Scalar.Scalar.BLOCK_LITERAL) {
          value += sep2 + indent.slice(trimIndent) + content;
          sep2 = "\n";
        } else if (indent.length > trimIndent || content[0] === "	") {
          if (sep2 === " ")
            sep2 = "\n";
          else if (!prevMoreIndented && sep2 === "\n")
            sep2 = "\n\n";
          value += sep2 + indent.slice(trimIndent) + content;
          sep2 = "\n";
          prevMoreIndented = true;
        } else if (content === "") {
          if (sep2 === "\n")
            value += "\n";
          else
            sep2 = "\n";
        } else {
          value += sep2 + content;
          sep2 = " ";
          prevMoreIndented = false;
        }
      }
      switch (header.chomp) {
        case "-":
          break;
        case "+":
          for (let i = chompStart; i < lines.length; ++i)
            value += "\n" + lines[i][0].slice(trimIndent);
          if (value[value.length - 1] !== "\n")
            value += "\n";
          break;
        default:
          value += "\n";
      }
      const end = start2 + header.length + scalar.source.length;
      return { value, type, comment: header.comment, range: [start2, end, end] };
    }
    function parseBlockScalarHeader({ offset, props }, strict, onError) {
      if (props[0].type !== "block-scalar-header") {
        onError(props[0], "IMPOSSIBLE", "Block scalar header not found");
        return null;
      }
      const { source } = props[0];
      const mode = source[0];
      let indent = 0;
      let chomp = "";
      let error = -1;
      for (let i = 1; i < source.length; ++i) {
        const ch = source[i];
        if (!chomp && (ch === "-" || ch === "+"))
          chomp = ch;
        else {
          const n = Number(ch);
          if (!indent && n)
            indent = n;
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
              const message2 = "Comments must be separated from other tokens by white space characters";
              onError(token, "MISSING_CHAR", message2);
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
            const message2 = `Unexpected token in block scalar header: ${token.type}`;
            onError(token, "UNEXPECTED_TOKEN", message2);
            const ts = token.source;
            if (ts && typeof ts === "string")
              length += ts.length;
          }
        }
      }
      return { mode, indent, chomp, comment, length };
    }
    function splitLines(source) {
      const split = source.split(/\n( *)/);
      const first = split[0];
      const m = first.match(/^( *)/);
      const line0 = m?.[1] ? [m[1], first.slice(m[1].length)] : ["", first];
      const lines = [line0];
      for (let i = 1; i < split.length; i += 2)
        lines.push([split[i], split[i + 1]]);
      return lines;
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
      const { offset, type, source, end } = scalar;
      let _type;
      let value;
      const _onError = (rel, code, msg) => onError(offset + rel, code, msg);
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
      const re = resolveEnd.resolveEnd(end, valueEnd, strict, onError);
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
      const line = /(.*?)\r?\n/sy;
      let match = line.exec(source);
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
      let sep2 = " ";
      let pos = line.lastIndex;
      while (match = line.exec(source)) {
        const lm = match[1].replace(trimBoth, "");
        if (lm === "") {
          if (sep2 === "\n")
            res += sep2;
          else
            sep2 = "\n";
        } else {
          res += sep2 + lm;
          sep2 = " ";
        }
        pos = line.lastIndex;
      }
      const last = /[ \t]*(.*)/sy;
      last.lastIndex = pos;
      match = last.exec(source);
      return res + sep2 + (match?.[1] ?? "");
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
      const ok = cc.length === length && /^[0-9a-fA-F]+$/.test(cc);
      const code = ok ? parseInt(cc, 16) : NaN;
      try {
        return String.fromCodePoint(code);
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
      let node;
      let isSrcToken = true;
      switch (token.type) {
        case "alias":
          node = composeAlias(ctx, token, onError);
          if (anchor || tag)
            onError(token, "ALIAS_PROPS", "An alias node must not specify any properties");
          break;
        case "scalar":
        case "single-quoted-scalar":
        case "double-quoted-scalar":
        case "block-scalar":
          node = composeScalar.composeScalar(ctx, token, tag, onError);
          if (anchor)
            node.anchor = anchor.source.substring(1);
          break;
        case "block-map":
        case "block-seq":
        case "flow-collection":
          try {
            node = composeCollection.composeCollection(CN, ctx, token, props, onError);
            if (anchor)
              node.anchor = anchor.source.substring(1);
          } catch (error) {
            const message2 = error instanceof Error ? error.message : String(error);
            onError(token, "RESOURCE_EXHAUSTION", message2);
          }
          break;
        default: {
          const message2 = token.type === "error" ? token.message : `Unsupported token (type: ${token.type})`;
          onError(token, "UNEXPECTED_TOKEN", message2);
          isSrcToken = false;
        }
      }
      node ?? (node = composeEmptyNode(ctx, token.offset, void 0, null, props, onError));
      if (anchor && node.anchor === "")
        onError(anchor, "BAD_ALIAS", "Anchor cannot be an empty string");
      if (atKey && ctx.options.stringKeys && (!identity.isScalar(node) || typeof node.value !== "string" || node.tag && node.tag !== "tag:yaml.org,2002:str")) {
        const msg = "With stringKeys, all keys must be strings";
        onError(tag ?? token, "NON_STRING_KEY", msg);
      }
      if (spaceBefore)
        node.spaceBefore = true;
      if (comment) {
        if (token.type === "scalar" && token.source === "")
          node.comment = comment;
        else
          node.commentBefore = comment;
      }
      if (ctx.options.keepSourceTokens && isSrcToken)
        node.srcToken = token;
      return node;
    }
    function composeEmptyNode(ctx, offset, before, pos, { spaceBefore, comment, anchor, tag, end }, onError) {
      const token = {
        type: "scalar",
        offset: utilEmptyScalarPosition.emptyScalarPosition(offset, before, pos),
        indent: -1,
        source: ""
      };
      const node = composeScalar.composeScalar(ctx, token, tag, onError);
      if (anchor) {
        node.anchor = anchor.source.substring(1);
        if (node.anchor === "")
          onError(anchor, "BAD_ALIAS", "Anchor cannot be an empty string");
      }
      if (spaceBefore)
        node.spaceBefore = true;
      if (comment) {
        node.comment = comment;
        node.range[2] = end;
      }
      return node;
    }
    function composeAlias({ options }, { offset, source, end }, onError) {
      const alias = new Alias.Alias(source.substring(1));
      if (alias.source === "")
        onError(offset, "BAD_ALIAS", "Alias cannot be an empty string");
      if (alias.source.endsWith(":"))
        onError(offset + source.length - 1, "BAD_ALIAS", "Alias ending in : is ambiguous", true);
      const valueEnd = offset + source.length;
      const re = resolveEnd.resolveEnd(end, valueEnd, options.strict, onError);
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
    function composeDoc(options, directives, { offset, start: start2, value, end }, onError) {
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
        next: value ?? end?.[0],
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
      const re = resolveEnd.resolveEnd(end, contentEnd, false, onError);
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
        this.onError = (source, code, message2, warning2) => {
          const pos = getErrorPos(source);
          if (warning2)
            this.warnings.push(new errors.YAMLWarning(pos, code, message2));
          else
            this.errors.push(new errors.YAMLParseError(pos, code, message2));
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
            this.directives.add(token.source, (offset, message2, warning2) => {
              const pos = getErrorPos(token);
              pos[0] += offset;
              this.onError(pos, "BAD_DIRECTIVE", message2, warning2);
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
            const end = resolveEnd.resolveEnd(token.end, token.offset + token.source.length, this.doc.options.strict, this.onError);
            this.decorate(this.doc, true);
            if (end.comment) {
              const dc = this.doc.comment;
              this.doc.comment = dc ? `${dc}
${end.comment}` : end.comment;
            }
            this.doc.range[2] = end.offset;
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
        const _onError = (pos, code, message2) => {
          const offset = typeof pos === "number" ? pos : Array.isArray(pos) ? pos[0] : pos.offset;
          if (onError)
            onError(offset, code, message2);
          else
            throw new errors.YAMLParseError([offset, offset + 1], code, message2);
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
      const { implicitKey = false, indent, inFlow = false, offset = -1, type = "PLAIN" } = context;
      const source = stringifyString.stringifyString({ type, value }, {
        implicitKey,
        indent: indent > 0 ? " ".repeat(indent) : "",
        inFlow,
        options: { blockQuote: true, lineWidth: -1 }
      });
      const end = context.end ?? [
        { type: "newline", offset: -1, indent, source: "\n" }
      ];
      switch (source[0]) {
        case "|":
        case ">": {
          const he = source.indexOf("\n");
          const head = source.substring(0, he);
          const body = source.substring(he + 1) + "\n";
          const props = [
            { type: "block-scalar-header", offset, indent, source: head }
          ];
          if (!addEndtoBlockProps(props, end))
            props.push({ type: "newline", offset: -1, indent, source: "\n" });
          return { type: "block-scalar", offset, indent, props, source: body };
        }
        case '"':
          return { type: "double-quoted-scalar", offset, indent, source, end };
        case "'":
          return { type: "single-quoted-scalar", offset, indent, source, end };
        default:
          return { type: "scalar", offset, indent, source, end };
      }
    }
    function setScalarValue(token, value, context = {}) {
      let { afterKey = false, implicitKey = false, inFlow = false, type } = context;
      let indent = "indent" in token ? token.indent : null;
      if (afterKey && typeof indent === "number")
        indent += 2;
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
        implicitKey: implicitKey || indent === null,
        indent: indent !== null && indent > 0 ? " ".repeat(indent) : "",
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
      const body = source.substring(he + 1) + "\n";
      if (token.type === "block-scalar") {
        const header = token.props[0];
        if (header.type !== "block-scalar-header")
          throw new Error("Invalid block scalar header");
        header.source = head;
        token.source = body;
      } else {
        const { offset } = token;
        const indent = "indent" in token ? token.indent : -1;
        const props = [
          { type: "block-scalar-header", offset, indent, source: head }
        ];
        if (!addEndtoBlockProps(props, "end" in token ? token.end : void 0))
          props.push({ type: "newline", offset: -1, indent, source: "\n" });
        for (const key of Object.keys(token))
          if (key !== "type" && key !== "offset")
            delete token[key];
        Object.assign(token, { type: "block-scalar", indent, props, source: body });
      }
    }
    function addEndtoBlockProps(props, end) {
      if (end)
        for (const st of end)
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
          const end = token.props.slice(1);
          let oa = source.length;
          if (token.props[0].type === "block-scalar-header")
            oa -= token.props[0].source.length;
          for (const tok of end)
            tok.offset += oa;
          delete token.props;
          Object.assign(token, { type, source, end });
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
          const indent = "indent" in token ? token.indent : -1;
          const end = "end" in token && Array.isArray(token.end) ? token.end.filter((st) => st.type === "space" || st.type === "comment" || st.type === "newline") : [];
          for (const key of Object.keys(token))
            if (key !== "type" && key !== "offset")
              delete token[key];
          Object.assign(token, { type, indent, source, end });
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
    var stringify = (cst) => "type" in cst ? stringifyToken(cst) : stringifyItem(cst);
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
    function stringifyItem({ start: start2, key, sep: sep2, value }) {
      let res = "";
      for (const st of start2)
        res += st.source;
      if (key)
        res += stringifyToken(key);
      if (sep2)
        for (const st of sep2)
          res += st.source;
      if (value)
        res += stringifyToken(value);
      return res;
    }
    exports.stringify = stringify;
  }
});

// node_modules/yaml/dist/parse/cst-visit.js
var require_cst_visit = __commonJS({
  "node_modules/yaml/dist/parse/cst-visit.js"(exports) {
    "use strict";
    var BREAK = /* @__PURE__ */ Symbol("break visit");
    var SKIP = /* @__PURE__ */ Symbol("skip children");
    var REMOVE = /* @__PURE__ */ Symbol("remove item");
    function visit(cst, visitor) {
      if ("type" in cst && cst.type === "document")
        cst = { start: cst.start, value: cst.value };
      _visit(Object.freeze([]), cst, visitor);
    }
    visit.BREAK = BREAK;
    visit.SKIP = SKIP;
    visit.REMOVE = REMOVE;
    visit.itemAtPath = (cst, path) => {
      let item = cst;
      for (const [field, index] of path) {
        const tok = item?.[field];
        if (tok && "items" in tok) {
          item = tok.items[index];
        } else
          return void 0;
      }
      return item;
    };
    visit.parentCollection = (cst, path) => {
      const parent = visit.itemAtPath(cst, path.slice(0, -1));
      const field = path[path.length - 1][0];
      const coll = parent?.[field];
      if (coll && "items" in coll)
        return coll;
      throw new Error("Parent collection not found");
    };
    function _visit(path, item, visitor) {
      let ctrl = visitor(item, path);
      if (typeof ctrl === "symbol")
        return ctrl;
      for (const field of ["key", "value"]) {
        const token = item[field];
        if (token && "items" in token) {
          for (let i = 0; i < token.items.length; ++i) {
            const ci = _visit(Object.freeze(path.concat([[field, i]])), token.items[i], visitor);
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
            ctrl = ctrl(item, path);
        }
      }
      return typeof ctrl === "function" ? ctrl(item, path) : ctrl;
    }
    exports.visit = visit;
  }
});

// node_modules/yaml/dist/parse/cst.js
var require_cst = __commonJS({
  "node_modules/yaml/dist/parse/cst.js"(exports) {
    "use strict";
    var cstScalar = require_cst_scalar();
    var cstStringify = require_cst_stringify();
    var cstVisit = require_cst_visit();
    var BOM = "\uFEFF";
    var DOCUMENT = "";
    var FLOW_END = "";
    var SCALAR = "";
    var isCollection = (token) => !!token && "items" in token;
    var isScalar = (token) => !!token && (token.type === "scalar" || token.type === "single-quoted-scalar" || token.type === "double-quoted-scalar" || token.type === "block-scalar");
    function prettyToken(token) {
      switch (token) {
        case BOM:
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
        case BOM:
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
    exports.BOM = BOM;
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
          let indent = 0;
          while (ch === " ")
            ch = this.buffer[++indent + offset];
          if (ch === "\r") {
            const next = this.buffer[indent + offset + 1];
            if (next === "\n" || !next && !this.atEnd)
              return offset + indent + 1;
          }
          return ch === "\n" || indent >= this.indentNext || !ch && !this.atEnd ? offset + indent : -1;
        }
        if (ch === "-" || ch === ".") {
          const dt = this.buffer.substr(offset, 3);
          if ((dt === "---" || dt === "...") && isEmpty(this.buffer[offset + 3]))
            return -1;
        }
        return offset;
      }
      getLine() {
        let end = this.lineEndPos;
        if (typeof end !== "number" || end !== -1 && end < this.pos) {
          end = this.buffer.indexOf("\n", this.pos);
          this.lineEndPos = end;
        }
        if (end === -1)
          return this.atEnd ? this.buffer.substring(this.pos) : null;
        if (this.buffer[end - 1] === "\r")
          end -= 1;
        return this.buffer.substring(this.pos, end);
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
        let line = this.getLine();
        if (line === null)
          return this.setNext("stream");
        if (line[0] === cst.BOM) {
          yield* this.pushCount(1);
          line = line.substring(1);
        }
        if (line[0] === "%") {
          let dirEnd = line.length;
          let cs = line.indexOf("#");
          while (cs !== -1) {
            const ch = line[cs - 1];
            if (ch === " " || ch === "	") {
              dirEnd = cs - 1;
              break;
            } else {
              cs = line.indexOf("#", cs + 1);
            }
          }
          while (true) {
            const ch = line[dirEnd - 1];
            if (ch === " " || ch === "	")
              dirEnd -= 1;
            else
              break;
          }
          const n = (yield* this.pushCount(dirEnd)) + (yield* this.pushSpaces(true));
          yield* this.pushCount(line.length - n);
          this.pushNewline();
          return "stream";
        }
        if (this.atLineEnd()) {
          const sp = yield* this.pushSpaces(true);
          yield* this.pushCount(line.length - sp);
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
        const line = this.getLine();
        if (line === null)
          return this.setNext("doc");
        let n = yield* this.pushIndicators();
        switch (line[n]) {
          case "#":
            yield* this.pushCount(line.length - n);
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
            yield* this.pushCount(line.length - n);
            yield* this.pushNewline();
            return yield* this.parseBlockScalar();
          default:
            return yield* this.parsePlainScalar();
        }
      }
      *parseFlowCollection() {
        let nl, sp;
        let indent = -1;
        do {
          nl = yield* this.pushNewline();
          if (nl > 0) {
            sp = yield* this.pushSpaces(false);
            this.indentValue = indent = sp;
          } else {
            sp = 0;
          }
          sp += yield* this.pushSpaces(true);
        } while (nl + sp > 0);
        const line = this.getLine();
        if (line === null)
          return this.setNext("flow");
        if (indent !== -1 && indent < this.indentNext && line[0] !== "#" || indent === 0 && (line.startsWith("---") || line.startsWith("...")) && isEmpty(line[3])) {
          const atFlowEndMarker = indent === this.indentNext - 1 && this.flowLevel === 1 && (line[0] === "]" || line[0] === "}");
          if (!atFlowEndMarker) {
            this.flowLevel = 0;
            yield cst.FLOW_END;
            return yield* this.parseLineStart();
          }
        }
        let n = 0;
        while (line[n] === ",") {
          n += yield* this.pushCount(1);
          n += yield* this.pushSpaces(true);
          this.flowKey = false;
        }
        n += yield* this.pushIndicators();
        switch (line[n]) {
          case void 0:
            return "flow";
          case "#":
            yield* this.pushCount(line.length - n);
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
        let end = this.buffer.indexOf(quote, this.pos + 1);
        if (quote === "'") {
          while (end !== -1 && this.buffer[end + 1] === "'")
            end = this.buffer.indexOf("'", end + 2);
        } else {
          while (end !== -1) {
            let n = 0;
            while (this.buffer[end - 1 - n] === "\\")
              n += 1;
            if (n % 2 === 0)
              break;
            end = this.buffer.indexOf('"', end + 1);
          }
        }
        const qb = this.buffer.substring(0, end);
        let nl = qb.indexOf("\n", this.pos);
        if (nl !== -1) {
          while (nl !== -1) {
            const cs = this.continueScalar(nl + 1);
            if (cs === -1)
              break;
            nl = qb.indexOf("\n", cs);
          }
          if (nl !== -1) {
            end = nl - (qb[nl - 1] === "\r" ? 2 : 1);
          }
        }
        if (end === -1) {
          if (!this.atEnd)
            return this.setNext("quoted-scalar");
          end = this.buffer.length;
        }
        yield* this.pushToIndex(end + 1, false);
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
        let indent = 0;
        let ch;
        loop: for (let i2 = this.pos; ch = this.buffer[i2]; ++i2) {
          switch (ch) {
            case " ":
              indent += 1;
              break;
            case "\n":
              nl = i2;
              indent = 0;
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
        if (indent >= this.indentNext) {
          if (this.blockScalarIndent === -1)
            this.indentNext = indent;
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
            if (ch2 === "\n" && i2 >= this.pos && i2 + 1 + indent > lastChar)
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
        let end = this.pos - 1;
        let i = this.pos - 1;
        let ch;
        while (ch = this.buffer[++i]) {
          if (ch === ":") {
            const next = this.buffer[i + 1];
            if (isEmpty(next) || inFlow && flowIndicatorChars.has(next))
              break;
            end = i;
          } else if (isEmpty(ch)) {
            let next = this.buffer[i + 1];
            if (ch === "\r") {
              if (next === "\n") {
                i += 1;
                ch = "\n";
                next = this.buffer[i + 1];
              } else
                end = i;
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
            end = i;
          }
        }
        if (!ch && !this.atEnd)
          return this.setNext("plain-scalar");
        yield cst.SCALAR;
        yield* this.pushToIndex(end + 1, true);
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
    function includesToken(list, type) {
      for (let i = 0; i < list.length; ++i)
        if (list[i].type === type)
          return true;
      return false;
    }
    function findNonEmptyIndex(list) {
      for (let i = 0; i < list.length; ++i) {
        switch (list[i].type) {
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
          const message2 = `Not a YAML token: ${source}`;
          yield* this.pop({ type: "error", offset: this.offset, message: message2, source });
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
          const message2 = "Tried to pop an empty stack";
          yield { type: "error", offset: this.offset, source: "", message: message2 };
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
          let sep2;
          if (scalar.end) {
            sep2 = scalar.end;
            sep2.push(this.sourceToken);
            delete scalar.end;
          } else
            sep2 = [this.sourceToken];
          const map = {
            type: "block-map",
            offset: scalar.offset,
            indent: scalar.indent,
            items: [{ start: start2, key: scalar, sep: sep2 }]
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
              const end = "end" in it.value ? it.value.end : void 0;
              const last = Array.isArray(end) ? end[end.length - 1] : void 0;
              if (last?.type === "comment")
                end?.push(this.sourceToken);
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
                const end = prev?.value?.end;
                if (Array.isArray(end)) {
                  arrayPushArray(end, it.start);
                  end.push(this.sourceToken);
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
                  const sep2 = it.sep;
                  sep2.push(this.sourceToken);
                  delete it.key;
                  delete it.sep;
                  this.stack.push({
                    type: "block-map",
                    offset: this.offset,
                    indent: this.indent,
                    items: [{ start: start3, key, sep: sep2 }]
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
              const end = "end" in it.value ? it.value.end : void 0;
              const last = Array.isArray(end) ? end[end.length - 1] : void 0;
              if (last?.type === "comment")
                end?.push(this.sourceToken);
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
                const end = prev?.value?.end;
                if (Array.isArray(end)) {
                  arrayPushArray(end, it.start);
                  end.push(this.sourceToken);
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
            const sep2 = fc.end.splice(1, fc.end.length);
            sep2.push(this.sourceToken);
            const map = {
              type: "block-map",
              offset: fc.offset,
              indent: fc.indent,
              items: [{ start: start2, key: fc, sep: sep2 }]
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
      atIndentedComment(start2, indent) {
        if (this.type !== "comment")
          return false;
        if (this.indent <= indent)
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
    function parseDocument(source, options = {}) {
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
    function parse3(src, reviver, options) {
      let _reviver = void 0;
      if (typeof reviver === "function") {
        _reviver = reviver;
      } else if (options === void 0 && reviver && typeof reviver === "object") {
        options = reviver;
      }
      const doc = parseDocument(src, options);
      if (!doc)
        return null;
      doc.warnings.forEach((warning2) => log.warn(doc.options.logLevel, warning2));
      if (doc.errors.length > 0) {
        if (doc.options.logLevel !== "silent")
          throw doc.errors[0];
        else
          doc.errors = [];
      }
      return doc.toJS(Object.assign({ reviver: _reviver }, options));
    }
    function stringify(value, replacer, options) {
      let _replacer = null;
      if (typeof replacer === "function" || Array.isArray(replacer)) {
        _replacer = replacer;
      } else if (options === void 0 && replacer) {
        options = replacer;
      }
      if (typeof options === "string")
        options = options.length;
      if (typeof options === "number") {
        const indent = Math.round(options);
        options = indent < 1 ? void 0 : indent > 8 ? { indent: 8 } : { indent };
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
    exports.parse = parse3;
    exports.parseAllDocuments = parseAllDocuments;
    exports.parseDocument = parseDocument;
    exports.stringify = stringify;
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
    var visit = require_visit();
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
    exports.visit = visit.visit;
    exports.visitAsync = visit.visitAsync;
  }
});

// src/messages.ts
var MESSAGES = {
  "assets.budget": "attachment budget exceeded; reduce attachments and retry",
  "assets.image-repair-budget": "Markdown exceeds the image repair budget.",
  "assets.spool-changed": "temporary attachment content changed; retry the run",
  "assets.spool-budget": "temporary attachment storage budget exceeded; reduce attachments and retry",
  // The command line and the action.
  "cli.missing-command": "missing command",
  "cli.unknown-command": "unknown command: {command}",
  "cli.node-too-old": "mdbisync requires Node.js 24.2 or later; install it and try again.",
  "cli.not-implemented": "{command}: not implemented",
  "action.unknown-operation": "unknown operation: {operation} (expected one of: {operations})",
  "action.unknown-security-step": "unknown security-step: {step} (expected one of: {steps}, or empty)",
  "action.cleanup-before-stage": "cleanup-tokens belongs before the stage step, not apply",
  "action.cleanup-revocation-failed": "token cleanup revocation failed",
  "output.invalid-text": "cannot write report text: expected printable Unicode text of at most {limit} characters",
  "output.invalid-count": "cannot write report metadata: expected a non-negative safe integer",
  "output.outside-directory": "report destination must stay inside the configured output directory",
  "output.linked-directory": "report destination {path} is a symbolic link inside the checkout",
  "output.link-loop": "report destination {path} passes through too many symbolic links",
  "output.not-a-file": "report destination {path} is not a regular file",
  // `init`.
  "init.security-twice": "choose security hooks once",
  "init.lfs-twice": "choose Git LFS once",
  "init.create-projects-release": "--create-projects requires a release that supports the create-projects action input. Release {version} does not support it",
  "init.unknown-option": "unknown option: {option}",
  "init.needs-value": "{option} needs a value",
  "init.given-twice": "{option} was given twice",
  "init.path-outside": "paths must stay inside the repository",
  "init.symlink": "setup destinations must not contain symlinks",
  "init.folder-is-file": "a setup folder path names a regular file",
  "init.invalid-yaml": "invalid YAML configuration",
  "init.needs-repos": "{file} needs a repos list",
  "init.invalid-repository-entry": "invalid pre-commit repository entry",
  "init.format-hook-differs": "existing linear-format hook uses a different repository or release",
  "init.security-hook-differs": "existing {hook} hook differs from the security example; reconcile it first",
  "init.release-sha": "--release-sha must be a full 40-character commit SHA",
  "init.release-too-old": "release {version} is older than {minimum}, the release these workflows are written for and checked against. Use {minimum} or later",
  "init.release-version": "--release-version must be a version such as v1.2.3",
  "init.not-at-root": "run init at the repository root",
  "init.workflow-differs": "existing workflow differs: {name}",
  // The action's inputs and the run's operation.
  "inputs.required": "the input {name} is required",
  "inputs.repository": `the input repository must be "owner/name" (it defaults to the workflow's repository)`,
  "inputs.document-cap": "the input document-cap must be a positive safe integer",
  "inputs.app-slug-required": "the input app-slug is required: give it the App token step's output app-slug",
  "inputs.app-slug": "the input app-slug must be a GitHub App slug (letters, digits and hyphens)",
  "inputs.merge-grace": "the input merge-grace-seconds must be an integer from 0 to 120",
  "inputs.check-deadline": "the input check-deadline-minutes must be an integer from 10 to 1440",
  "inputs.required-checks": "the input required-checks must name each check with the publisher it must come from, one per line, as `<name> @ actions` for a GitHub Actions job, `<name> @ app:<App id>` or `<name> @ status:<account id>`, with names of at most 255 characters; this line is not: {line}",
  "inputs.merge-without-checks": "the input merge-without-checks must be true or false",
  "inputs.create-projects": "the input create-projects must be true or false",
  "inputs.direction": "the input direction {problem} (initial sync never picks a direction itself)",
  "inputs.direction-missing": "is required",
  "inputs.direction-unknown": 'must be one of {directions}, not "{direction}"',
  "operation.initial-sync-inputs": "the direction and confirm inputs belong to an initial sync, and only to it",
  // How a run ends.
  "run.partial": "partial, will continue",
  "run.container-cap": "{command}: stopped before any write (container-cap); reduce additions or check document-cap",
  "run.stopped-before-write": "{command}: stopped before any write ({code}){detail}",
  "run.stopped-detail": ": {detail}",
  "run.how-to-fix": "{message}. How to fix it: {url}",
  "run.stopped-by-linear": "{command}: stopped by Linear before any write; run it again once the limit has reset",
  "run.project-create-stopped": "{command}: stopped by Linear while creating projects. Run it again once the limit has reset",
  "run.project-create-failed": "Could not create {project} in Linear ({reason}). Check its name and the app\u2019s access, including any renamed or archived project, then run again.",
  "run.not-finished-sync-branch": "{command}: not finished ({code}); merge or close the pull request of the sync branch and delete the branch, then run it again",
  "run.not-finished": "{command}: not finished ({code}); run it again with the same inputs",
  "run.revoke-failed": "the run's Linear token could not be revoked: {reason}",
  "run.container-not-read": "container documents were not read",
  "pull-request.merge-misplaced": "setup error ({code}): GitHub merged a sync pull request into {where}, not onto the tracked branch commit the sync checked; a person checks that branch",
  "pull-request.merge-blocked": "setup error ({code}): GitHub refuses again to merge the sync pull request ({refusal})",
  "pull-request.checks-missing": "setup error ({code}): the sync pull request waited past the check deadline for checks that never started ({checks})",
  "pull-request.initial-pending": "stopped short ({code}): an initial sync from Linear waits for a person to merge it",
  "pull-request.head-unverified": "waits for a person ({code}): the sync pull request also changes files that are not synchronized documents or their assets ({files}); a person reviews and merges it",
  "pull-request.push-rejected": "setup error ({code}): GitHub refused the push to the sync branch ({reason}); let the sync's GitHub App push to it",
  "pull-request.github-refused": "setup error ({code}): GitHub refused a request for the sync pull request (HTTP {status}); the job summary names it",
  "pull-request.suspended-asset-discovery": "the batch stays suspended ({code}). {reason}",
  // The setup check.
  "setup.left-out": "{count} files left out, not synced: {files}{more}",
  "setup.left-out-more": ", and {count} more",
  "setup.no-annotations": "no folder has linear-team or linear-project in its README.md front matter",
  "setup.github-rate-limited": "GitHub rate-limited the setup check while reading the repository (HTTP 403); run again later",
  "setup.github-rate-limited-permission": "GitHub rate-limited the setup check while checking {permission} (HTTP 403); run again later",
  "setup.github-refused": "the GitHub token was refused (HTTP {status})",
  "setup.github-cannot-see": "the GitHub token cannot see the repository (HTTP {status})",
  "setup.github-answered-permission": "GitHub answered HTTP {status} while checking {permission}",
  "setup.github-reading-repository": "reading the repository",
  "setup.github-lacks": "the GitHub token lacks {permissions}{unchecked}",
  "setup.github-lacks-unchecked": " ({permissions} not checked without it)",
  "setup.github-rate-limited-app": "GitHub rate-limited the setup check while reading the App's account (HTTP 403); run again later",
  "setup.github-reading-app": "reading the App's account",
  "setup.github-app-not-found": "GitHub has no App account {login}; give app-slug the App token step's output app-slug",
  "setup.merge-commits-unknown": "GitHub did not show whether merge commits are allowed",
  "setup.merge-commits-off": "merge commits are not allowed in the repository settings",
  "setup.github-rate-limited-rules": "GitHub rate-limited the setup check while reading the rules of {branch} (HTTP {status}); run again later",
  "setup.sync-branch-rules-plan": "GitHub rulesets are unavailable for this repository on its current plan. To restrict sync branch creation and deletion, use a plan that supports rulesets for this repository and configure an active ruleset.",
  "setup.sync-branch-rules-unread": "GitHub answered HTTP {status} while reading the rules of {branch}; the sync branches may not be kept to the App",
  "setup.sync-branch-rules": "{branches}: {rules}",
  "setup.sync-branch-rules-open": "{branches}: {rules}; no ruleset keeps those who can push from creating or deleting a sync branch",
  "setup.sync-branch-rule-restricted": "{rule} restricted",
  "setup.sync-branch-rule-open": "{rule} not restricted on {branches}",
  "setup.security-hooks-inline-allow": "security hook {hooks} runs Gitleaks without {flag}, so an inline gitleaks:allow comment in a document from Linear exempts its line; add {flag} (init updates the hook it generated) and keep exceptions in .gitleaks.toml or .gitleaksignore",
  "setup.security-hooks-missing": 'no pre-commit hook marked "alias: {alias}": content is pushed unchecked',
  "setup.hooks-invalid-yaml": "{file} is not valid YAML",
  "setup.hooks-no-repos": '{file} has no "repos" list',
  "setup.format-hook-missing": "{file} has no {hook} hook",
  "setup.linear-refused-credentials": "Linear refused the OAuth app client credentials",
  "setup.linear-refused-teams": "Linear refused the token while reading teams",
  "setup.linear-scope": "the Linear token lacks the scope {scopes}",
  "setup.too-many-projects": "more than 250 Linear projects share the annotated names",
  "setup.no-team-visible": "the Linear app saw no team in two lookups, so none of the annotated teams ({teams}) can be found: check the app's team access in Linear",
  "setup.target-not-found": "not found in Linear: {targets}",
  "setup.target-ambiguous": "more than one match in Linear: {targets}",
  "setup.target-shared": "more than one folder maps to {targets}",
  "setup.project-create-failed": "Linear did not confirm project creation",
  "setup.project-name-changed": "Linear returned a different name for the created project",
  "setup.linear-untrusted": "{ref} is at a commit the sync did not sign: someone else pushed it, or the sync wrote it before it signed its records or under another linear-client-secret. Its files could reach the sync pull request unchecked. Run initial sync again to record the state anew. The sync wrote nothing.",
  "setup.initial-sync-unfinished": "An initial sync stopped before it finished: run it again with the same inputs first. The sync wrote nothing.",
  "setup.initial-sync-required": "{ref} does not exist: run initial sync first. The sync wrote nothing.",
  "setup.initial-pull-request-pending": "The pull request of the initial sync from Linear is not merged into {tracked} yet: a person reviews and merges it with a merge commit (it can remove files), then the sync runs. Closing the pull request or deleting its branch does not cancel this unmerged snapshot. To start over instead, close that pull request, delete the branch {sync} and run initial sync again to replace the snapshot. The sync wrote nothing.",
  // Annotations and the mapping.
  "annotations.blob-too-large": "{readme}: cannot check the folder annotation because the blob exceeds {bytes} bytes",
  "annotations.invalid-yaml": "{readme}: the front matter with {teamKey} or {projectKey} is not valid YAML",
  "annotations.empty-name": "{readme}: {key} must be a non-empty name",
  "annotations.nested-team": '{readme}: names a team inside the folder of team "{team}" ({folder})',
  "annotations.nested-project": '{readme}: names a project inside the folder of project "{project}" ({folder})',
  "annotations.project-without-team": "{readme}: names a project, but neither it nor a folder above names a team",
  "mapping.content-not-read": "the content of {path} was not read",
  "mapping.blob-budget": "mapping-blob-budget: Markdown blob reads exceed the {bytes}-byte budget",
  // State refs and their files.
  "config.invalid-remote": 'remote "{remote}" is not a valid remote name',
  "config.invalid-branch": '{key} "{branch}" is not a valid branch name: {problem}',
  "config.starts-with-dash": 'starts with "-"',
  "config.same-branches": "the tracked branch and both sync lane branches must differ",
  "config.nested-branches": "one of the tracked branch and the sync branch is a folder of the other",
  "config.invalid-prefix": 'refPrefix "{prefix}" is not a valid ref prefix: {problem}',
  "config.prefix-outside-refs": 'refPrefix "{prefix}" must start with "refs/" and name a folder under it',
  "config.prefix-reserved": 'refPrefix "{prefix}" must not be under refs/heads, refs/tags or refs/remotes',
  "git.failed": "git {args} failed with exit code {code}: {stderr}",
  "git.output-limit": "git-output-limit: command output exceeded {bytes} bytes",
  "lfs.needs-git-lfs": "files stored in Git LFS need a working git-lfs on PATH; install git-lfs before the sync",
  "objects.missing": "git object {oid} is missing",
  "objects.bad-tree": "a git tree object could not be read",
  "objects.batch-name": "git object name {name} cannot be asked in a batch",
  "objects.invalid-entry-name": "invalid tree entry name {name}",
  "git.unreadable-answer": "git {command} gave an answer that could not be read",
  "git.starter-ended": "the process that starts git commands ended ({reason})",
  "objects.not-blob": "git object {oid} is a {type}, not a blob",
  "objects.invalid-path": "invalid repository path {path}",
  "state.tracked-missing": 'the tracked branch "{branch}" does not exist on remote "{remote}"',
  "state.not-fast-forward": "refusing to move {ref} to a commit that does not descend from its current value",
  "state.same-ref-twice": "a push names the same ref twice",
  "state.invalid-path-entry": "{file} has an invalid entry for a path",
  "state.duplicate-document-id": "{file} maps a document id to more than one path",
  "state.invalid-entry": "{file} has an invalid entry",
  "state.file-missing": "{file} is missing in state commit {commit}",
  "state.invalid-json": "{file} in {commit} is not valid JSON",
  "state.not-object": "{file} in {commit} is not a JSON object",
  // Linear and its storage.
  "linear.cleanup-not-exclusive": "token cleanup requires exclusive use of the Linear app",
  "linear.comment-mismatch": "Comment identity does not match its document",
  "linear.updated-comment-mismatch": "Updated comment identity does not match",
  "linear.created-comment-mismatch": "Created comment identity does not match",
  "linear.no-upload-target": "{operation}: Linear returned no upload target",
  "linear.storage-failed": "{operation}: storage request failed",
  "linear.storage-answered": "{operation}: storage answered HTTP {status}",
  "linear.page-without-cursor": "{operation}: Linear reported another page without a cursor",
  "linear.not-success": "{operation}: Linear reported success: false",
  "linear.stopped": "{operation}: Linear client stopped ({reason})",
  "linear.rate-limited": "rate limited",
  "linear.rate-limited-retry": "rate limited, retry after {seconds} s",
  "linear.budget-low": "{header} is {remaining}, below {threshold}",
  "linear.error": "{operation}: Linear error {code} (HTTP {status}, request {request}): {detail}",
  "linear.answered": "{operation}: Linear answered HTTP {status} (request {request})",
  "linear.request-failed": "{operation}: request to Linear failed ({cause})",
  "linear.response-too-large": "linear-response-too-large: {operation}: a Linear answer is over the {bytes}-byte limit and was not read",
  "linear.body-budget": "linear-body-budget: {operation}: the Linear document bodies this run reads are over the {bytes}-byte budget",
  "linear.too-long": "{operation}: {field} is {length} characters, Linear accepts at most {limit}",
  "linear.read-back-failed": "{operation}: written, but reading back the stored record failed",
  "linear.token-refused": "oauth.token: Linear refused the token request ({reason})",
  "linear.revoke-unconfirmed": "oauth.revoke: Linear did not confirm the revocation (HTTP {status})",
  "linear.token-request-failed": "{operation}: request to Linear failed",
  "linear.upload-not-allowed": "upload destination is not allowed",
  "linear.not-in-upload-cache": "a linked file is not in the upload cache",
  // GitHub's pull request API.
  "github.no-answer": "GitHub did not answer while {action}",
  "github.answered": "GitHub answered HTTP {status} while {action}",
  "github.listing": "listing open pull requests",
  "github.reading-pull-request": "reading a pull request",
  "github.opening": "opening a pull request",
  "github.updating": "updating a pull request",
  "github.closing": "closing a pull request",
  "github.sending": "sending {method} to the pull request API",
  "github.reading-check-runs": "reading the check runs of the sync pull request",
  "github.reading-annotations": "reading the annotations of a failed check run",
  "github.reading-statuses": "reading the commit statuses of the sync pull request",
  "github.merging": "merging the sync pull request",
  // Initial sync.
  "initial-sync.state-moved": "a state ref moved while the run was writing",
  "initial-sync.document-not-listed": "the planned document for {path} was not listed",
  "initial-sync.document-not-read": "the planned document for {path} was not read with its text",
  "initial-sync.links-not-prepared": "document-links: apply before prepare",
  "initial-sync.project-not-resolved": 'project "{project}" of team "{team}" was not resolved',
  "initial-sync.team-not-resolved": 'team "{team}" was not resolved',
  "initial-sync.text-not-read": "the text of {path} was not read",
  "initial-sync.misplaced": "the recorded tree maps {count} files to other documents",
  "initial-sync.over-upload-limit": "{files}: over the upload limit of {limit} bytes",
  "initial-sync.lfs-extensions": "{files}: stored with LFS extensions, which are not supported",
  "initial-sync.link-provenance-unknown": "{files}: linked as a plain link from a document Linear holds, and the state that names the links Linear members wrote is lost",
  "initial-sync.upload-unreadable": "{file} cannot be read: {reason}",
  "initial-sync.uploads-not-prepared": "the uploads transform was not prepared",
  // The sync.
  "sync.needs-initial-sync": "run initial sync first",
  "sync.places-unresolved": "the previously recorded document places could not be resolved",
  "sync.recorded-place-unknown": "the recorded state names a Linear place for {folder} that is not a move the tracked branch made and the sync has not recorded yet; the state refs were changed outside the sync",
  "sync.recorded-project-missing": 'previously synchronized project "{project}" of team "{team}" is missing in Linear. Restore access to the project or update its annotation before syncing',
  "sync.lost-lease": "state moved while recording document marks",
  "sync.no-lfs-pointer": "LFS did not return a pointer",
  "sync.lfs-pointer-mismatch": "LFS returned a pointer to other content than it was given",
  "sync.entry-mismatch": "Document and id entry do not match",
  "sync.needs-content": "Status reconciliation requires document content",
  "sync.needs-comment-target": "A marked document requires a comment target",
  "sync.no-merge-tree": "git merge-tree gave no tree",
  "sync.no-safe-path": "no safe destination for a document",
  "sync.invalid-update-time": "a document has an invalid update time",
  "sync.invalid-security-config": "invalid security hook configuration",
  "sync.needs-pre-commit": "security hooks require pre-commit on PATH; install pre-commit before capture",
  "sync.security-link-outside": "a tracked symbolic link leads outside the tree the security hooks check",
  "sync.security-scratch-tree": "security-scratch-tree: the scratch repository of the security hooks differs from the tracked tree, most often because this file system ignores case or Unicode normalization",
  "sync.security-scratch-budget": "security-scratch-budget: the tracked files the security hooks need exceed the {bytes}-byte scratch budget",
  "sync.no-runner-temp": "RUNNER_TEMP is not set; the staged security steps run in a GitHub Actions job",
  "sync.staged-version": "the staged candidates come from another version of the action",
  "sync.staged-hash": "the staged manifest names a file that is not a content hash",
  "sync.link-variant-budget": "Some documents that link other changed documents were staged only in part: if the hooks refuse a document they link, they wait for a later run.",
  "sync.write-before-record": "the sync writes to Linear only after initial sync has recorded `linear`",
  "sync.merge-conflict-output": "Invalid merge-file conflict output",
  "assets.not-allowed": "asset destination is not allowed",
  "assets.download-failed": "asset could not be downloaded",
  "assets.destination-exists": "asset destination already exists"
};
function message(key, ...values) {
  const filled = values[0];
  return MESSAGES[key].replace(/\{(\w+)\}/g, (_, name) => String(filled?.[name]));
}

// src/state/config.ts
var DEFAULT_STATE_CONFIG = Object.freeze({
  remote: "origin",
  trackedBranch: "main",
  syncBranch: "mdbisync/linear",
  refPrefix: "refs/mdbisync"
});

// src/state/git.ts
import { existsSync } from "node:fs";
import { join as join2 } from "node:path";

// src/state/batch.ts
import { spawn } from "node:child_process";
import { statSync } from "node:fs";
var IDLE_MS = 1e3;
var Queue = class {
  items = [];
  head = 0;
  get size() {
    return this.items.length - this.head;
  }
  push(item) {
    this.items.push(item);
  }
  first() {
    return this.items[this.head];
  }
  shift() {
    this.head++;
    if (this.head > 1024 && this.head * 2 > this.items.length) {
      this.items = this.items.slice(this.head);
      this.head = 0;
    }
  }
  drain() {
    const rest = this.items.slice(this.head);
    this.items = [];
    this.head = 0;
    return rest;
  }
};
var BatchProcess = class {
  options;
  running;
  starting;
  directory;
  constructor(options) {
    this.options = options;
  }
  /** Writes `input` and waits for its answer. */
  async request(input, request) {
    let running = this.running;
    if (running === void 0 || this.directory === void 0 || identityOf(this.directory) !== running.identity) running = await this.start();
    const current = running;
    return new Promise((resolve, reject) => {
      if (current.idle !== void 0) clearTimeout(current.idle);
      current.idle = void 0;
      if (current.pending.size === 0) hold(current.child, true);
      current.pending.push({ request, resolve, reject });
      current.child.stdin.write(input);
    });
  }
  /** Ends the process; the next request starts a new one. */
  close() {
    const running = this.running;
    this.running = void 0;
    if (running === void 0) return;
    if (running.idle !== void 0) clearTimeout(running.idle);
    running.child.stdin.end();
  }
  start() {
    if (this.starting === void 0) {
      const starting = (async () => {
        this.close();
        this.directory ??= await this.options.objectDirectory();
        const running = this.spawn(this.directory);
        this.running = running;
        return running;
      })();
      this.starting = starting;
      const clear = () => {
        if (this.starting === starting) this.starting = void 0;
      };
      starting.then(clear, clear);
    }
    return this.starting;
  }
  spawn(directory) {
    const { dir, args, env } = this.options;
    const child = spawn("git", args, { cwd: dir, env: { ...env(), GIT_FLUSH: "1" }, stdio: ["pipe", "pipe", "pipe"] });
    const running = { child, identity: identityOf(directory), pending: new Queue(), chunks: [], length: 0, need: 0, stderr: "", idle: void 0 };
    child.stdout.on("data", (chunk) => this.receive(running, chunk));
    child.stderr.on("data", (chunk) => {
      if (running.stderr.length < 64 * 1024) running.stderr += chunk.toString("utf8");
    });
    child.stdin.on("error", () => {
    });
    let ended = false;
    const end = (code) => {
      if (ended) return;
      ended = true;
      if (running.idle !== void 0) clearTimeout(running.idle);
      if (this.running === running) this.running = void 0;
      const error = new GitError(args, code, running.stderr);
      const waiting = running.pending.drain();
      for (const request of waiting) request.reject(error);
      if (waiting.length > 0) this.options.onIdle?.();
    };
    child.on("error", () => end(-1));
    child.on("close", (code) => end(code ?? -1));
    hold(child, false);
    return running;
  }
  receive(running, chunk) {
    running.chunks.push(chunk);
    running.length += chunk.length;
    if (running.length < running.need) return;
    let buffered = running.chunks.length === 1 ? running.chunks[0] : Buffer.concat(running.chunks);
    running.chunks = [buffered];
    while (running.pending.size > 0) {
      const waiting = running.pending.first();
      let parsed;
      try {
        parsed = this.options.parse(buffered, waiting.request);
      } catch (error) {
        this.broken(running, error);
        return;
      }
      if (parsed === void 0 || "need" in parsed) {
        running.need = parsed === void 0 ? buffered.length + 1 : parsed.need;
        break;
      }
      buffered = buffered.subarray(parsed.bytes);
      running.chunks = buffered.length === 0 ? [] : [buffered];
      running.length = buffered.length;
      running.need = 0;
      running.pending.shift();
      if (running.pending.size === 0) this.rest(running);
      waiting.resolve(parsed.answer);
    }
  }
  /** Nothing waits: the process must not keep the program running, and it ends unless a request comes soon. */
  rest(running) {
    hold(running.child, false);
    running.idle = setTimeout(() => {
      if (this.running === running) this.close();
    }, IDLE_MS);
    running.idle.unref();
    this.options.onIdle?.();
  }
  broken(running, cause) {
    if (this.running === running) this.running = void 0;
    const error = new GitError(this.options.args, -1, cause.message);
    for (const waiting of running.pending.drain()) waiting.reject(error);
    running.child.kill("SIGKILL");
    this.options.onIdle?.();
  }
};
function parseLine(buffer) {
  const newline = buffer.indexOf(10);
  return newline < 0 ? void 0 : { answer: buffer.subarray(0, newline).toString("utf8"), bytes: newline + 1 };
}
function hold(child, waiting) {
  for (const handle of [child, child.stdin, child.stdout, child.stderr]) {
    if (waiting) handle.ref();
    else handle.unref();
  }
}
function identityOf(directory) {
  try {
    const stat = statSync(directory);
    return `${stat.dev}:${stat.ino}`;
  } catch {
    return "missing";
  }
}

// src/state/object-reader.ts
var HEADER = /^([0-9a-f]{40}|[0-9a-f]{64}) ([a-z]+) ([0-9]+)$/;
function batchName(name) {
  return name !== "" && !/[\n\r\0]/.test(name) && name.trim() === name;
}
var ObjectReader = class {
  process;
  /**
   * @param dir the directory the process runs in
   * @param env the environment of the process
   * @param objectDirectory gives the absolute path of the repository's object directory
   */
  constructor(dir, env, objectDirectory) {
    this.process = new BatchProcess({ dir, args: ["cat-file", "--batch-command"], env, objectDirectory, parse });
  }
  /** The object a name resolves to, with its content; null when the name resolves to no object. */
  contents(name) {
    return this.ask(name, true);
  }
  /** The id, type and size of the object a name resolves to; null when it resolves to no object. */
  info(name) {
    return this.ask(name, false);
  }
  async ask(name, contents) {
    if (!batchName(name)) throw new Error(message("objects.batch-name", { name: JSON.stringify(name) }));
    return this.process.request(`${contents ? "contents" : "info"} ${name}
`, { name, contents });
  }
};
function parse(buffer, request) {
  const newline = buffer.indexOf(10);
  if (newline < 0) return void 0;
  const header = buffer.subarray(0, newline).toString("utf8");
  const match = HEADER.exec(header);
  if (match === null) {
    if (header === `${request.name} missing` || header === `${request.name} ambiguous`) return { answer: null, bytes: newline + 1 };
    throw new Error(message("git.unreadable-answer", { command: "cat-file" }));
  }
  const info = { oid: match[1], type: match[2], size: Number(match[3]) };
  if (!request.contents) return { answer: info, bytes: newline + 1 };
  const end = newline + 1 + info.size;
  if (buffer.length < end + 1) return { need: end + 1 };
  return { answer: { ...info, content: Buffer.from(buffer.subarray(newline + 1, end)) }, bytes: end + 1 };
}

// src/state/object-writer.ts
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
var ObjectWriter = class {
  blobs;
  trees;
  /** Blob content waits in a file here while git reads it; the folder is there only while blobs are being written. */
  folder;
  files = 0;
  writing = 0;
  /** Writes waiting for one of the `BLOBS_AT_ONCE` places, so the folder holds a bounded number of blobs. */
  waiting = [];
  /**
   * @param dir the directory the processes run in
   * @param env the environment of the processes
   * @param objectDirectory gives the absolute path of the repository's object directory
   */
  constructor(dir, env, objectDirectory) {
    const oid = (buffer) => parseLine(buffer);
    this.blobs = new BatchProcess({
      dir,
      env,
      objectDirectory,
      parse: oid,
      args: ["-c", "core.fsyncMethod=fsync", "-c", `core.bigFileThreshold=${Number.MAX_SAFE_INTEGER}`, "hash-object", "-w", "--no-filters", "--stdin-paths"]
    });
    this.trees = new BatchProcess({ dir, env, objectDirectory, parse: oid, args: ["mktree", "-z", "--batch"] });
  }
  /**
   * Stores content as a blob, exactly as given (no clean filters, no LFS).
   * Content given as a function is read only when the blob's turn comes.
   */
  async blob(content) {
    if (this.writing >= BLOBS_AT_ONCE) await new Promise((resolve) => this.waiting.push(resolve));
    else this.writing++;
    let path;
    try {
      this.folder ??= mkdtempSync(join(tmpdir(), "blob-"));
      path = join(this.folder, String(this.files++));
      writeFileSync(path, typeof content === "function" ? content() : content, { mode: 384 });
      return checkOid(await this.blobs.request(`${path}
`, path), "hash-object");
    } finally {
      if (path !== void 0) rmSync(path, { force: true });
      const next = this.waiting.shift();
      if (next !== void 0) next();
      else if (--this.writing === 0) this.clearFolder();
    }
  }
  /** Stores a tree of these entries; git sorts them. */
  async tree(entries) {
    const records = entries.map((entry) => {
      if (entry.name.length === 0 || entry.name.includes(0) || entry.name.includes(47)) throw new Error(message("objects.invalid-entry-name", { name: JSON.stringify(entry.name.toString("utf8")) }));
      return Buffer.concat([Buffer.from(`${entry.mode} ${entry.type} ${entry.oid}	`), entry.name, NUL]);
    });
    const input = Buffer.concat([...records, NUL]);
    try {
      return checkOid(await this.trees.request(input, null), "mktree");
    } catch (error) {
      if (!(error instanceof GitError && error.stderr.includes("is unavailable"))) throw error;
      return checkOid(await this.trees.request(input, null), "mktree");
    }
  }
  clearFolder() {
    const folder = this.folder;
    this.folder = void 0;
    if (folder !== void 0) rmSync(folder, { recursive: true, force: true });
  }
};
var NUL = Buffer.from([0]);
var BLOBS_AT_ONCE = 8;
function checkOid(line, command) {
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(line)) throw new Error(message("git.unreadable-answer", { command }));
  return line;
}

// src/state/spawner.ts
import { spawn as spawn2 } from "node:child_process";
var HELPER = String.raw`
'use strict';
const { spawn } = require('node:child_process');
const { createWriteStream } = require('node:fs');
const { pipeline } = require('node:stream/promises');
const failure = (error) => ({ message: String(error && error.message), code: error && error.code, errno: error && error.errno, syscall: error && error.syscall, path: error && error.path });
const reply = (message) => { if (process.connected) process.send(message); };
function run(id, request) {
  const child = spawn('git', request.args, { cwd: request.cwd, env: request.env, stdio: [request.file ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
  const out = [];
  const err = [];
  let exceeded;
  const collector = (chunks, limit) => {
    let bytes = 0;
    return (chunk) => {
      if (exceeded !== undefined) return;
      bytes += chunk.length;
      if (limit !== undefined && bytes > limit) {
        exceeded = limit;
        child.kill('SIGKILL');
        return;
      }
      chunks.push(chunk);
    };
  };
  // A bounded call stops the command when its standard error passes 64 KiB as well; a call that streams to a file
  // keeps the first 64 KiB of it and lets the command finish.
  let kept = 0;
  const firstPart = (chunk) => { if (kept < 64 * 1024) { kept += chunk.length; err.push(chunk); } };
  if (!request.file) child.stdout.on('data', collector(out, request.maxOutputBytes));
  child.stderr.on('data', request.file ? firstPart : collector(err, request.maxOutputBytes !== undefined ? 64 * 1024 : undefined));
  let failed;
  const exited = new Promise((resolve) => {
    child.on('error', (error) => { failed = error; resolve(-1); });
    child.on('close', (code) => resolve(code === null ? -1 : code));
  });
  if (!request.file) {
    child.stdin.on('error', () => {});
    child.stdin.end(request.input === undefined ? '' : request.input);
  }
  const copied = request.file
    ? pipeline(child.stdout, createWriteStream(request.file.path, { flags: 'wx', mode: request.file.mode })).catch((error) => { child.kill('SIGKILL'); throw error; })
    : Promise.resolve();
  copied.then(() => exited).then((code) => {
    if (failed !== undefined) return reply({ id, failure: failure(failed) });
    reply({ id, result: { code, stdout: Buffer.concat(out), stderr: Buffer.concat(err).toString('utf8'), exceeded } });
  }, (error) => exited.then(() => reply({ id, failure: failure(failed === undefined ? error : failed) })));
}
process.on('message', ({ id, request }) => {
  // A command that cannot even start (an argument with a NUL in it) fails alone.
  try { run(id, request); } catch (error) { reply({ id, failure: failure(error) }); }
});
process.on('disconnect', () => process.exit(0));
`;
var helper;
var pending = /* @__PURE__ */ new Map();
var nextId = 0;
function start() {
  const { NODE_OPTIONS: _options, ...env } = process.env;
  const child = spawn2(process.execPath, ["-e", HELPER], { stdio: ["ignore", "ignore", "inherit", "ipc"], serialization: "advanced", env });
  child.on("message", (message2) => {
    const waiting = pending.get(message2.id);
    if (waiting === void 0) return;
    pending.delete(message2.id);
    if (pending.size === 0) hold2(child, false);
    if ("result" in message2) waiting.resolve({ ...message2.result, stdout: Buffer.from(message2.result.stdout) });
    else waiting.reject(Object.assign(new Error(message2.failure.message), withoutUndefined(message2.failure)));
  });
  const end = (error) => {
    if (helper === child) helper = void 0;
    for (const [id, waiting] of pending) {
      pending.delete(id);
      waiting.reject(error);
    }
  };
  child.on("error", end);
  child.on("exit", (code, signal) => end(new Error(message("git.starter-ended", { reason: String(signal ?? code) }))));
  hold2(child, false);
  return child;
}
function hold2(child, waiting) {
  const channel = child.channel;
  if (waiting) {
    child.ref();
    channel?.ref();
  } else {
    child.unref();
    channel?.unref();
  }
}
function withoutUndefined(failure) {
  return Object.fromEntries(Object.entries(failure).filter(([key, value]) => key !== "message" && value !== void 0 && value !== null));
}
function spawnGit(request) {
  helper ??= start();
  const child = helper;
  const id = nextId++;
  return new Promise((resolve, reject) => {
    if (pending.size === 0) hold2(child, true);
    pending.set(id, { resolve, reject });
    child.send({ id, request });
  });
}

// src/state/content.ts
import { createHash } from "node:crypto";
import { mkdtempSync as mkdtempSync2, writeFileSync as writeFileSync2, readFileSync, rmSync as rmSync2 } from "node:fs";
var isSpooled = (content) => typeof content === "object" && !Buffer.isBuffer(content);
function contentBytes(content) {
  if (!isSpooled(content)) return Buffer.from(content);
  const bytes = readFileSync(content.file);
  if (bytes.length !== content.size || createHash("sha256").update(bytes).digest("hex") !== content.hash) throw new Error(message("assets.spool-changed"));
  return bytes;
}

// src/state/objects.ts
var NEUTRAL_IDENTITY = Object.freeze({ name: "mdbisync", email: "mdbisync@sync.invalid" });
function listTree(git, treeish, maxOutputBytes) {
  return git.listTree(treeish, maxOutputBytes);
}
async function readTreeListing(git, treeish, maxOutputBytes) {
  let files;
  try {
    files = await walkTree(git, treeish, maxOutputBytes === void 0 ? void 0 : { maxOutputBytes, sized: true });
  } catch (error) {
    if (!(error instanceof TreeOverLimit)) throw error;
    const { stdout } = await git.run(["ls-tree", "-r", "-z", "-l", "--full-tree", treeish], { maxOutputBytes });
    return parseTreeListing(stdout);
  }
  const sizes = await Promise.all(files.map((file) => file.type === "blob" ? git.objectInfo(file.oid) : null));
  let bytes = 0;
  return files.map((file, index) => {
    const size = file.type === "blob" ? sizes[index]?.size ?? Number.NaN : null;
    if (maxOutputBytes !== void 0) {
      bytes += file.bytes + Math.max(7, size === null ? 1 : Number.isNaN(size) ? 3 : String(size).length);
      if (bytes > maxOutputBytes) throw new GitOutputLimitError(maxOutputBytes);
    }
    return { path: file.path, mode: file.mode, type: file.type, oid: file.oid, size };
  });
}
async function walkTree(git, treeish, limit) {
  const root = await readTree(git, `${treeish}^{tree}`, limit?.maxOutputBytes);
  if (root === null || root.type !== "tree") throw new GitError(["ls-tree", "-r", "--full-tree", treeish], 128, `fatal: not a tree object: ${treeish}`);
  const rawLength = root.oid.length / 2;
  const files = [];
  let bytes = 0;
  const walk = async (content, prefix) => {
    const entries = parseTree(content, rawLength);
    const subtrees = entries.map((entry) => limit === void 0 && entry.mode === "040000" ? git.readObject(entry.oid) : void 0);
    for (const read of subtrees) read?.catch(() => {
    });
    for (const [index, entry] of entries.entries()) {
      const path = prefix.length === 0 ? entry.name : Buffer.concat([prefix, SLASH, entry.name]);
      if (entry.mode === "040000") {
        const tree = await (subtrees[index] ?? readTree(git, entry.oid, limit === void 0 ? void 0 : limit.maxOutputBytes - bytes));
        if (tree === null || tree === void 0 || tree.type !== "tree") throw new GitError(["ls-tree", "-r", "--full-tree", treeish], 128, `fatal: not a tree object: ${entry.oid}`);
        await walk(tree.content, path);
        continue;
      }
      const type = entry.mode === "160000" ? "commit" : "blob";
      const record = entry.mode.length + type.length + entry.oid.length + path.length + 5;
      if (limit !== void 0) {
        bytes += record + (limit.sized ? 7 : -1);
        if (bytes > limit.maxOutputBytes) throw new GitOutputLimitError(limit.maxOutputBytes);
      }
      files.push({ path: path.toString("utf8"), mode: entry.mode, type, oid: entry.oid, bytes: record });
    }
  };
  await walk(root.content, Buffer.alloc(0));
  return files;
}
var SLASH = Buffer.from("/");
var TreeOverLimit = class extends Error {
};
async function readTree(git, name, budget) {
  if (budget === void 0) return git.readObject(name);
  const info = await git.objectInfo(name);
  if (info === null) return null;
  if (info.type === "tree" && info.size > budget) throw new TreeOverLimit();
  return git.readObject(info.oid);
}
function parseTree(content, rawLength) {
  const entries = [];
  let offset = 0;
  while (offset < content.length) {
    const space = content.indexOf(32, offset);
    const nul = content.indexOf(0, space + 1);
    if (space < 0 || nul < 0 || nul + 1 + rawLength > content.length) throw new Error(message("objects.bad-tree"));
    const mode = canonicalMode(Number.parseInt(content.subarray(offset, space).toString("latin1"), 8));
    entries.push({ mode, name: content.subarray(space + 1, nul), oid: content.subarray(nul + 1, nul + 1 + rawLength).toString("hex") });
    offset = nul + 1 + rawLength;
  }
  return entries;
}
function canonicalMode(mode) {
  const kind = mode & 61440;
  const canonical = kind === 32768 ? 32768 | (mode & 64 ? 493 : 420) : kind === 40960 ? 40960 : kind === 16384 ? 16384 : 57344;
  return canonical.toString(8).padStart(6, "0");
}
function parseTreeListing(stdout) {
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
function readBlobs(git, oids, maxOutputBytes) {
  return git.readBlobs(oids, maxOutputBytes);
}
async function readBlobBatch(git, oids, maxOutputBytes) {
  const unique = [...new Set(oids)];
  const result = /* @__PURE__ */ new Map();
  if (unique.length === 0) return result;
  if (maxOutputBytes !== void 0) {
    const infos = await Promise.all(unique.map((oid) => git.objectInfo(oid)));
    let bytes = 0;
    infos.forEach((info, index) => {
      bytes += info === null ? `${unique[index]} missing
`.length : `${info.oid} ${info.type} ${info.size}
`.length + info.size + 1;
    });
    if (bytes > maxOutputBytes) throw new GitOutputLimitError(maxOutputBytes);
  }
  const objects = await Promise.all(unique.map((oid) => git.readObject(oid)));
  unique.forEach((oid, index) => {
    const found = objects[index];
    if (found === null || found === void 0) throw new Error(message("objects.missing", { oid }));
    if (found.type !== "blob") throw new Error(message("objects.not-blob", { oid, type: found.type }));
    result.set(oid, found.content);
  });
  return result;
}
function isGitDirectoryName(part) {
  return /^(?:\.git|git~[0-9]+)[. ]*(?::|$)/i.test(part.replace(HFS_IGNORED, ""));
}
var HFS_IGNORED = /[\u200c-\u200f\u202a-\u202e\u206a-\u206f\ufeff]/g;
function checkRepoPath(path, { removal = false } = {}) {
  const parts = path.split("/");
  if (path === "" || path.includes("\0") || path.includes("\\")) throw new Error(message("objects.invalid-path", { path: JSON.stringify(path) }));
  for (const part of parts) {
    if (part === "" || part === "." || part === ".." || !removal && isGitDirectoryName(part)) {
      throw new Error(message("objects.invalid-path", { path: JSON.stringify(path) }));
    }
  }
}

// src/state/git.ts
var GitError = class extends Error {
  args;
  code;
  stderr;
  constructor(args, code, stderr) {
    super(message("git.failed", { args: args.join(" "), code, stderr: stderr.trim() }));
    this.name = "GitError";
    this.args = args;
    this.code = code;
    this.stderr = stderr;
  }
};
var GitOutputLimitError = class extends Error {
  bytes;
  constructor(bytes) {
    super(message("git.output-limit", { bytes }));
    this.name = "GitOutputLimitError";
    this.bytes = bytes;
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
  environment(options) {
    const env = options.onlyEnv !== void 0 ? { ...BASE_ENV, ...options.onlyEnv } : { ...process.env, ...BASE_ENV, ...this.env, ...options.env };
    for (const key of Object.keys(env)) {
      if (env[key] === void 0) delete env[key];
    }
    return env;
  }
  reader;
  writer;
  /** The absolute path of the repository's object directory, for the long-lived processes to notice a repository made again. */
  objectDirectory = () => {
    return this.layout().then(({ objects }) => objects);
  };
  layoutRead;
  /** The repository's object format and folders, from one `rev-parse`; they do not change while the repository exists. */
  layout() {
    this.layoutRead ??= this.text(["rev-parse", "--show-object-format", "--path-format=absolute", "--git-path", "objects", "--git-common-dir"]).then(
      async (text) => {
        const lines = text.split("\n");
        if (lines.length === 3) return { format: lines[0], objects: lines[1], common: lines[2] };
        const [format, objects, common] = await Promise.all([
          this.text(["rev-parse", "--show-object-format"]),
          this.text(["rev-parse", "--path-format=absolute", "--git-path", "objects"]),
          this.text(["rev-parse", "--path-format=absolute", "--git-common-dir"])
        ]);
        return { format, objects, common };
      },
      (error) => {
        this.layoutRead = void 0;
        throw error;
      }
    );
    return this.layoutRead;
  }
  /**
   * Reads objects through one long-lived git process instead of a process
   * per read. Names are revisions as `git cat-file` takes them (`<oid>`,
   * `<commit>:<path>`, `<ref>^{commit}`).
   */
  objects() {
    this.reader ??= new ObjectReader(this.dir, () => this.environment({}), this.objectDirectory);
    return this.reader;
  }
  /** Writes blobs and trees through long-lived git processes instead of a process per object. */
  objectWriter() {
    this.writer ??= new ObjectWriter(this.dir, () => this.environment({}), this.objectDirectory);
    return this.writer;
  }
  /** The object a name resolves to, with its content; null when it resolves to none. */
  async readObject(name) {
    if (batchName(name)) return this.objects().contents(name);
    const found = await this.run(["rev-parse", "--verify", "--quiet", "--end-of-options", name], { okCodes: [0, 1, 128] });
    if (found.code !== 0) return null;
    const oid = found.stdout.toString("utf8").trim();
    return this.objects().contents(oid);
  }
  /**
   * Every file of a commit or tree, recursively, as `git ls-tree -r -l`
   * lists them (see `listTree` in objects.ts).
   */
  listTree(treeish, maxOutputBytes) {
    return readTreeListing(this, treeish, maxOutputBytes);
  }
  /** Blobs by id, one batch (see `readBlobs` in objects.ts). */
  readBlobs(oids, maxOutputBytes) {
    return readBlobBatch(this, oids, maxOutputBytes);
  }
  /** The content of the blob a name resolves to, as `git cat-file blob` gives it; null when it resolves to no blob. */
  async readBlob(name, maxBytes) {
    if (maxBytes === void 0) {
      const found = await this.readObject(name);
      return found?.type === "blob" ? found.content : null;
    }
    const info = await this.objectInfo(name);
    if (info?.type !== "blob") return null;
    if (info.size > maxBytes) throw new GitOutputLimitError(maxBytes);
    return (await this.objects().contents(info.oid))?.content ?? null;
  }
  /**
   * The id a name resolves to, as `git rev-parse <name>` gives it: read
   * through the object reader, and from `rev-parse` itself (with its error)
   * when the reader finds no object.
   */
  async revParse(name) {
    return (await this.objectInfo(name))?.oid ?? this.text(["rev-parse", name]);
  }
  /**
   * What `git show <name>` gives: for a blob its content, read through the
   * object reader; anything else, and a name that resolves to nothing, is
   * left to `git show` itself.
   */
  async showBlob(name, options = {}) {
    const found = await this.readObject(name);
    if (found?.type === "blob") return { code: 0, stdout: found.content, stderr: "" };
    return this.run(["show", name], options);
  }
  /** The id, type and size of the object a name resolves to; null when it resolves to none. */
  async objectInfo(name) {
    if (batchName(name)) return this.objects().info(name);
    const found = await this.run(["rev-parse", "--verify", "--quiet", "--end-of-options", name], { okCodes: [0, 1, 128] });
    if (found.code !== 0) return null;
    return this.objects().info(found.stdout.toString("utf8").trim());
  }
  plain;
  /**
   * True when git prints commit messages as stored, without re-encoding:
   * the repository sets no message encoding other than UTF-8
   * (`i18n.commitEncoding`, `i18n.logOutputEncoding`).
   */
  plainMessages() {
    this.plain ??= this.run(["config", "--get-regexp", "^i18n\\.(commitencoding|logoutputencoding)$"], { okCodes: [0, 1] }).then(
      ({ stdout }) => stdout.toString("utf8").split("\n").filter(Boolean).every((line) => /^\S+ utf-?8$/i.test(line)),
      (error) => {
        this.plain = void 0;
        throw error;
      }
    );
    return this.plain;
  }
  /**
   * True when git reads some commits' parents other than as stored: a
   * shallow repository cuts history at its boundary, and grafts replace
   * parents. Checked on every call, as a fetch can make a repository shallow.
   */
  async rewritesHistory() {
    const env = this.environment({});
    if (env.GIT_SHALLOW_FILE !== void 0 || env.GIT_GRAFT_FILE !== void 0) return true;
    const { common } = await this.layout();
    return existsSync(join2(common, "shallow")) || existsSync(join2(common, "info", "grafts"));
  }
  /** The repository's object format, `sha1` or `sha256`; it does not change while the repository exists. */
  objectFormat() {
    return this.layout().then(({ format }) => format);
  }
  async run(args, options = {}) {
    const okCodes = options.okCodes ?? [0];
    const result = await spawnGit({ args, cwd: this.dir, env: this.environment(options), input: options.input ?? "", ...options.maxOutputBytes === void 0 ? {} : { maxOutputBytes: options.maxOutputBytes } });
    if (result.exceeded !== void 0) throw new GitOutputLimitError(result.exceeded);
    const { code, stdout, stderr } = result;
    if (!okCodes.includes(code)) throw new GitError(args, code, stderr);
    return { code, stdout, stderr };
  }
  /**
   * Runs git and writes its standard output to a new file at `path` as it
   * arrives, so output of any size is never held in memory. Standard error
   * is capped at 64 KiB. A failing exit is a `GitError`.
   */
  async runToFile(args, path, fileMode) {
    const { code, stderr } = await spawnGit({ args, cwd: this.dir, env: this.environment({}), file: { path, mode: fileMode } });
    if (code !== 0) throw new GitError(args, code, stderr);
  }
  /** Runs git and returns standard output as text without the final newline. */
  async text(args, options = {}) {
    const { stdout } = await this.run(args, options);
    return stdout.toString("utf8").replace(/\n$/, "");
  }
};

// src/state/observation.ts
var SIGNATURE = "Sync-signature";
var SIGNED = new RegExp(`^([\\s\\S]*)\\n\\n${SIGNATURE}: ([0-9a-f]{64})\\n$`);

// src/state/lfs.ts
var POINTER_VERSION = "version https://git-lfs.github.com/spec/v1";
var MAX_POINTER_SIZE = 1024;
function parseLfsPointer(blob) {
  if (blob.length >= MAX_POINTER_SIZE || !blob.subarray(0, POINTER_VERSION.length).equals(Buffer.from(POINTER_VERSION))) {
    return null;
  }
  const text = blob.toString("utf8");
  if (!text.endsWith("\n")) return null;
  const lines = text.slice(0, -1).split("\n");
  if (lines[0] !== POINTER_VERSION) return null;
  let oid = null;
  let size = null;
  let extensions = false;
  for (const line of lines.slice(1)) {
    const space = line.indexOf(" ");
    if (space <= 0) return null;
    const key = line.slice(0, space);
    const value = line.slice(space + 1);
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
var LFSCONFIG_LIMIT = 64 * 1024;

// src/sync/staged.ts
import { createHash as createHash3 } from "node:crypto";
import { mkdir as mkdir2, readFile as readFile2, rm as rm2, writeFile as writeFile2 } from "node:fs/promises";
import { join as join4 } from "node:path";

// src/mapping/front-matter.ts
var import_yaml = __toESM(require_dist(), 1);

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
  add(index, remove, add) {
    addImplementation(this, index, remove, add, false);
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
  addBefore(index, remove, add) {
    addImplementation(this, index, remove, add, true);
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
    let index = this.map.length;
    const vecs = [];
    while (index > 0) {
      index -= 1;
      vecs.push(events.slice(this.map[index][0] + this.map[index][1]), this.map[index][2]);
      events.length = this.map[index][0];
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

// src/format/bare-domain.ts
var TLDS = new Set(`
aaa aarp abb abbott abbvie abc able abogado abudhabi ac academy accenture accountant accountants
aco actor ad ads adult ae aeg aero aetna af afl africa ag agakhan agency ai aig airbus airforce
airtel akdn al alibaba alipay allfinanz allstate ally alsace alstom am amazon americanexpress
americanfamily amex amfam amica amsterdam an analytics android anquan anz ao aol apartments app
apple aq aquarelle ar arab aramco archi army arpa art arte as asda asia associates at athleta
attorney au auction audi audible audio auspost author auto autos aw aws ax axa az azure ba baby
baidu banamex band bank bar barcelona barclaycard barclays barefoot bargains baseball basketball
bauhaus bayern bb bbc bbt bbva bcg bcn bd be beats beauty beer berlin best bestbuy bet bf bg bh
bharti bi bible bid bike bing bingo bio biz bj black blackfriday blockbuster blog bloomberg blue
bm bms bmw bn bnpparibas bo boats boehringer bofa bom bond boo book booking bosch bostik boston
bot boutique box br bradesco bridgestone broadway broker brother brussels bs bt build builders
business buy buzz bv bw by bz bzh ca cab cafe cal call calvinklein cam camera camp canon capetown
capital capitalone car caravan cards care career careers cars casa case cash casino cat catering
catholic cba cbn cbre cc cd center ceo cern cf cfa cfd cg ch chanel channel charity chase chat
cheap chintai christmas chrome church ci cipriani circle cisco citadel citi citic city ck cl
claims cleaning click clinic clinique clothing cloud club clubmed cm cn co coach codes coffee
college cologne com commbank community company compare computer comsec condos construction
consulting contact contractors cooking cool coop corsica country coupon coupons courses cpa cr
credit creditcard creditunion cricket crown crs cruise cruises cu cuisinella cv cw cx cy cymru
cyou cz dad dance data date dating datsun day dclk dds de deal dealer deals degree delivery dell
deloitte delta democrat dental dentist desi design dev dhl diamonds diet digital direct directory
discount discover dish diy dj dk dm dnp do docs doctor dog domains dot download drive dtv dubai
dupont durban dvag dvr dz earth eat ec eco edeka edu education ee eg email emerck energy engineer
engineering enterprises epson equipment er ericsson erni es esq estate et eu eurovision eus events
exchange expert exposed express extraspace fage fail fairwinds faith family fan fans farm farmers
fashion fast fedex feedback ferrari ferrero fi fidelity fido film final finance financial fire
firestone firmdale fish fishing fit fitness fj fk flickr flights flir florist flowers fly fm fo
foo food football ford forex forsale forum foundation fox fr free fresenius frl frogans frontier
ftr fujitsu fun fund furniture futbol fyi ga gal gallery gallo gallup game games gap garden gay gb
gbiz gd gdn ge gea gent genting george gf gg ggee gh gi gift gifts gives giving gl glass gle
global globo gm gmail gmbh gmo gmx gn godaddy gold goldpoint golf goodyear goog google gop got gov
gp gq gr grainger graphics gratis green gripe grocery group gs gt gu gucci guge guide guitars guru
gw gy hair hamburg hangout haus hbo hdfc hdfcbank health healthcare help here hermes hiphop
hisamitsu hitachi hiv hk hkt hm hn hockey holdings holiday homedepot homegoods homes homesense
honda horse hospital host hosting hot hotels hotmail house how hr hsbc ht hu hughes hyatt hyundai
ibm icbc ice icu id ie ieee ifm ikano il im imamat imdb immo immobilien in inc industries infiniti
info ing ink institute insurance insure int international intuit investments io ipiranga iq ir
irish is ismaili ist istanbul it itau itv jaguar java jcb je jeep jetzt jewelry jio jll jm jmp jnj
jo jobs joburg jot joy jp jpmorgan jprs juegos kaufen kddi ke kerryhotels kerryproperties kfh kg
kh ki kia kids kim kindle kitchen kiwi km kn koeln komatsu kosher kp kpmg kpn kr krd kred
kuokgroup kw ky kyoto kz la lacaixa lamborghini lamer land landrover lanxess lasalle lat latino
latrobe law lawyer lb lc lds lease leclerc lefrak legal lego lexus lgbt li lidl life lifeinsurance
lifestyle lighting like lilly limited limo lincoln link live living lk llc llp loan loans locker
locus lol london lotte lotto love lpl lplfinancial lr ls lt ltd ltda lu lundbeck luxe luxury lv ly
ma madrid maif maison makeup man management mango map market marketing markets marriott marshalls
mattel mba mc mckinsey md me med media meet melbourne meme memorial men menu merck merckmsd mg mh
miami microsoft mil mini mint mit mitsubishi mk ml mlb mls mm mma mn mo mobi mobile moda moe moi
mom monash money monster mormon mortgage moscow moto motorcycles mov movie mp mq mr ms msd mt mtn
mtr mu museum music mv mw mx my mz na nab nagoya name navy nba nc ne nec net netbank netflix
network neustar new news next nextdirect nexus nf nfl ng ngo nhk ni nico nike nikon ninja nissan
nissay nl no nokia norton now nowruz nowtv np nr nra nrw ntt nu nyc nz obi observer office okinawa
olayan olayangroup ollo om omega one ong onl online ooo open oracle orange org organic origins
osaka otsuka ott ovh pa page panasonic paris pars partners parts party pay pccw pe pet pf pfizer
pg ph pharmacy phd philips phone photo photography photos physio pics pictet pictures pid pin ping
pink pioneer pizza pk pl place play playstation plumbing plus pm pn pnc pohl poker politie porn
post pr praxi press prime pro prod productions prof progressive promo properties property
protection pru prudential ps pt pub pw pwc py qa qpon quebec quest racing radio re read realestate
realtor realty recipes red redumbrella rehab reise reisen reit reliance ren rent rentals repair
report republican rest restaurant review reviews rexroth rich richardli ricoh ril rio rip ro rocks
rodeo rogers room rs rsvp ru rugby ruhr run rw rwe ryukyu sa saarland safe safety sakura sale
salon samsclub samsung sandvik sandvikcoromant sanofi sap sarl sas save saxo sb sbi sbs sc scb
schaeffler schmidt scholarships school schule schwarz science scot sd se search seat secure
security seek select sener services seven sew sex sexy sfr sg sh shangrila sharp shell shia
shiksha shoes shop shopping shouji show si silk sina singles site sj sk ski skin sky skype sl
sling sm smart smile sn sncf so soccer social softbank software sohu solar solutions song sony soy
spa space sport spot sr srl ss st stada staples star statebank statefarm stc stcgroup stockholm
storage store stream studio study style su sucks supplies supply support surf surgery suzuki sv
swatch swiss sx sy sydney systems sz tab taipei talk taobao target tatamotors tatar tattoo tax
taxi tc tci td tdk team tech technology tel temasek tennis teva tf tg th thd theater theatre tiaa
tickets tienda tips tires tirol tj tjmaxx tjx tk tkmaxx tl tm tmall tn to today tokyo tools top
toray toshiba total tours town toyota toys tr trade trading training travel travelers
travelersinsurance trust trv tt tube tui tunes tushu tv tvs tw tz ua ubank ubs ug uk unicom
university uno uol ups us uy uz va vacations vana vanguard vc ve vegas ventures verisign
versicherung vet vg vi viajes video vig viking villas vin vip virgin visa vision viva vivo
vlaanderen vn vodka volvo vote voting voto voyage vu wales walmart walter wang wanggou watch
watches weather weatherchannel web webcam weber website wed wedding weibo weir wf whoswho wien
wiki williamhill win windows wine winners wme woodside work works world wow ws wtc wtf xbox xerox
xin xn--11b4c3d xn--1ck2e1b xn--1qqw23a xn--2scrj9c xn--30rr7y xn--3bst00m xn--3ds443g
xn--3e0b707e xn--3hcrj9c xn--3pxu8k xn--42c2d9a xn--45br5cyl xn--45brj9c xn--45q11c xn--4dbrk0ce
xn--4gbrim xn--54b7fta0cc xn--55qw42g xn--55qx5d xn--5su34j936bgsg xn--5tzm5g xn--6frz82g
xn--6qq986b3xl xn--80adxhks xn--80ao21a xn--80aqecdr1a xn--80asehdb xn--80aswg xn--8y0a063a
xn--90a3ac xn--90ae xn--90ais xn--9dbq2a xn--9et52u xn--9krt00a xn--b4w605ferd xn--bck1b9a5dre4c
xn--c1avg xn--c2br7g xn--cck2b3b xn--cckwcxetd xn--cg4bki xn--clchc0ea0b2g2a9gcd xn--czr694b
xn--czrs0t xn--czru2d xn--d1acj3b xn--d1alf xn--e1a4c xn--eckvdtc9d xn--efvy88h xn--fct429k
xn--fhbei xn--fiq228c5hs xn--fiq64b xn--fiqs8s xn--fiqz9s xn--fjq720a xn--flw351e xn--fpcrj9c3d
xn--fzc2c9e2c xn--fzys8d69uvgm xn--g2xx48c xn--gckr3f0f xn--gecrj9c xn--gk3at1e xn--h2breg3eve
xn--h2brj9c xn--h2brj9c8c xn--hxt814e xn--i1b6b1a6a2e xn--imr513n xn--io0a7i xn--j1aef xn--j1amh
xn--j6w193g xn--jlq480n2rg xn--jvr189m xn--kcrx77d1x4a xn--kprw13d xn--kpry57d xn--kput3i
xn--l1acc xn--lgbbat1ad8j xn--mgb9awbf xn--mgba3a3ejt xn--mgba3a4f16a xn--mgba7c0bbn0a
xn--mgbaam7a8h xn--mgbab2bd xn--mgbah1a3hjkrd xn--mgbai9azgqp6j xn--mgbayh7gpa xn--mgbbh1a
xn--mgbbh1a71e xn--mgbc0a9azcg xn--mgbca7dzdo xn--mgbcpq6gpa1a xn--mgberp4a5d4ar xn--mgbgu82a
xn--mgbi4ecexp xn--mgbpl2fh xn--mgbt3dhd xn--mgbtx2b xn--mgbx4cd0ab xn--mix891f xn--mk1bu44c
xn--mxtq1m xn--ngbc5azd xn--ngbe9e0a xn--ngbrx xn--node xn--nqv7f xn--nqv7fs00ema xn--nyqy26a
xn--o3cw4h xn--ogbpf8fl xn--otu796d xn--p1acf xn--p1ai xn--pgbs0dh xn--pssy2u xn--q7ce6a
xn--q9jyb4c xn--qcka1pmc xn--qxa6a xn--qxam xn--rhqv96g xn--rovu88b xn--rvc1e0am3e xn--s9brj9c
xn--ses554g xn--t60b56a xn--tckwe xn--tiq49xqyj xn--unup4y xn--vermgensberater-ctb
xn--vermgensberatung-pwb xn--vhquv xn--vuq861b xn--w4r85el8fhu5dnra xn--w4rs40l xn--wgbh1c
xn--wgbl6a xn--xhq521b xn--xkc2al3hye2a xn--xkc2dl3a5ee0h xn--y9a3aq xn--yfro4i67o xn--ygbi2ammx
xn--zfr164b xxx xyz yachts yahoo yamaxun yandex ye yodobashi yoga yokohama you youtube yt yun za
zappos zara zero zip zm zone zuerich zw
`.trim().split(/\s+/));

// src/vendor/emoji-mart-data/linear-emoji.json
var linear_emoji_default = {
  "100": "\u{1F4AF}",
  "1234": "\u{1F522}",
  grinning: "\u{1F600}",
  smiley: "\u{1F603}",
  smile: "\u{1F604}",
  grin: "\u{1F601}",
  laughing: "\u{1F606}",
  sweat_smile: "\u{1F605}",
  rolling_on_the_floor_laughing: "\u{1F923}",
  joy: "\u{1F602}",
  slightly_smiling_face: "\u{1F642}",
  upside_down_face: "\u{1F643}",
  melting_face: "\u{1FAE0}",
  wink: "\u{1F609}",
  blush: "\u{1F60A}",
  innocent: "\u{1F607}",
  smiling_face_with_3_hearts: "\u{1F970}",
  heart_eyes: "\u{1F60D}",
  "star-struck": "\u{1F929}",
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
  hugging_face: "\u{1F917}",
  face_with_hand_over_mouth: "\u{1F92D}",
  face_with_open_eyes_and_hand_over_mouth: "\u{1FAE2}",
  face_with_peeking_eye: "\u{1FAE3}",
  shushing_face: "\u{1F92B}",
  thinking_face: "\u{1F914}",
  saluting_face: "\u{1FAE1}",
  zipper_mouth_face: "\u{1F910}",
  face_with_raised_eyebrow: "\u{1F928}",
  neutral_face: "\u{1F610}",
  expressionless: "\u{1F611}",
  no_mouth: "\u{1F636}",
  dotted_line_face: "\u{1FAE5}",
  face_in_clouds: "\u{1F636}\u200D\u{1F32B}\uFE0F",
  smirk: "\u{1F60F}",
  unamused: "\u{1F612}",
  face_with_rolling_eyes: "\u{1F644}",
  grimacing: "\u{1F62C}",
  face_exhaling: "\u{1F62E}\u200D\u{1F4A8}",
  lying_face: "\u{1F925}",
  relieved: "\u{1F60C}",
  pensive: "\u{1F614}",
  sleepy: "\u{1F62A}",
  drooling_face: "\u{1F924}",
  sleeping: "\u{1F634}",
  mask: "\u{1F637}",
  face_with_thermometer: "\u{1F912}",
  face_with_head_bandage: "\u{1F915}",
  nauseated_face: "\u{1F922}",
  face_vomiting: "\u{1F92E}",
  sneezing_face: "\u{1F927}",
  hot_face: "\u{1F975}",
  cold_face: "\u{1F976}",
  woozy_face: "\u{1F974}",
  dizzy_face: "\u{1F635}",
  face_with_spiral_eyes: "\u{1F635}\u200D\u{1F4AB}",
  exploding_head: "\u{1F92F}",
  face_with_cowboy_hat: "\u{1F920}",
  partying_face: "\u{1F973}",
  disguised_face: "\u{1F978}",
  sunglasses: "\u{1F60E}",
  nerd_face: "\u{1F913}",
  face_with_monocle: "\u{1F9D0}",
  confused: "\u{1F615}",
  face_with_diagonal_mouth: "\u{1FAE4}",
  worried: "\u{1F61F}",
  slightly_frowning_face: "\u{1F641}",
  white_frowning_face: "\u2639\uFE0F",
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
  angry: "\u{1F620}",
  face_with_symbols_on_mouth: "\u{1F92C}",
  smiling_imp: "\u{1F608}",
  imp: "\u{1F47F}",
  skull: "\u{1F480}",
  skull_and_crossbones: "\u2620\uFE0F",
  hankey: "\u{1F4A9}",
  clown_face: "\u{1F921}",
  japanese_ogre: "\u{1F479}",
  japanese_goblin: "\u{1F47A}",
  ghost: "\u{1F47B}",
  alien: "\u{1F47D}",
  space_invader: "\u{1F47E}",
  robot_face: "\u{1F916}",
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
  heavy_heart_exclamation_mark_ornament: "\u2763\uFE0F",
  broken_heart: "\u{1F494}",
  heart_on_fire: "\u2764\uFE0F\u200D\u{1F525}",
  mending_heart: "\u2764\uFE0F\u200D\u{1FA79}",
  heart: "\u2764\uFE0F",
  orange_heart: "\u{1F9E1}",
  yellow_heart: "\u{1F49B}",
  green_heart: "\u{1F49A}",
  blue_heart: "\u{1F499}",
  purple_heart: "\u{1F49C}",
  brown_heart: "\u{1F90E}",
  black_heart: "\u{1F5A4}",
  white_heart: "\u{1F90D}",
  kiss: "\u{1F48B}",
  anger: "\u{1F4A2}",
  boom: "\u{1F4A5}",
  dizzy: "\u{1F4AB}",
  sweat_drops: "\u{1F4A6}",
  dash: "\u{1F4A8}",
  hole: "\u{1F573}\uFE0F",
  speech_balloon: "\u{1F4AC}",
  "eye-in-speech-bubble": "\u{1F441}\uFE0F\u200D\u{1F5E8}\uFE0F",
  left_speech_bubble: "\u{1F5E8}\uFE0F",
  right_anger_bubble: "\u{1F5EF}\uFE0F",
  thought_balloon: "\u{1F4AD}",
  zzz: "\u{1F4A4}",
  wave: "\u{1F44B}",
  raised_back_of_hand: "\u{1F91A}",
  raised_hand_with_fingers_splayed: "\u{1F590}\uFE0F",
  hand: "\u270B",
  "spock-hand": "\u{1F596}",
  rightwards_hand: "\u{1FAF1}",
  leftwards_hand: "\u{1FAF2}",
  palm_down_hand: "\u{1FAF3}",
  palm_up_hand: "\u{1FAF4}",
  ok_hand: "\u{1F44C}",
  pinched_fingers: "\u{1F90C}",
  pinching_hand: "\u{1F90F}",
  v: "\u270C\uFE0F",
  crossed_fingers: "\u{1F91E}",
  hand_with_index_finger_and_thumb_crossed: "\u{1FAF0}",
  i_love_you_hand_sign: "\u{1F91F}",
  the_horns: "\u{1F918}",
  call_me_hand: "\u{1F919}",
  point_left: "\u{1F448}",
  point_right: "\u{1F449}",
  point_up_2: "\u{1F446}",
  middle_finger: "\u{1F595}",
  point_down: "\u{1F447}",
  point_up: "\u261D\uFE0F",
  index_pointing_at_the_viewer: "\u{1FAF5}",
  "+1": "\u{1F44D}",
  "-1": "\u{1F44E}",
  fist: "\u270A",
  facepunch: "\u{1F44A}",
  "left-facing_fist": "\u{1F91B}",
  "right-facing_fist": "\u{1F91C}",
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
  person_with_blond_hair: "\u{1F471}",
  man: "\u{1F468}",
  bearded_person: "\u{1F9D4}",
  man_with_beard: "\u{1F9D4}\u200D\u2642\uFE0F",
  woman_with_beard: "\u{1F9D4}\u200D\u2640\uFE0F",
  red_haired_man: "\u{1F468}\u200D\u{1F9B0}",
  curly_haired_man: "\u{1F468}\u200D\u{1F9B1}",
  white_haired_man: "\u{1F468}\u200D\u{1F9B3}",
  bald_man: "\u{1F468}\u200D\u{1F9B2}",
  woman: "\u{1F469}",
  red_haired_woman: "\u{1F469}\u200D\u{1F9B0}",
  red_haired_person: "\u{1F9D1}\u200D\u{1F9B0}",
  curly_haired_woman: "\u{1F469}\u200D\u{1F9B1}",
  curly_haired_person: "\u{1F9D1}\u200D\u{1F9B1}",
  white_haired_woman: "\u{1F469}\u200D\u{1F9B3}",
  white_haired_person: "\u{1F9D1}\u200D\u{1F9B3}",
  bald_woman: "\u{1F469}\u200D\u{1F9B2}",
  bald_person: "\u{1F9D1}\u200D\u{1F9B2}",
  "blond-haired-woman": "\u{1F471}\u200D\u2640\uFE0F",
  "blond-haired-man": "\u{1F471}\u200D\u2642\uFE0F",
  older_adult: "\u{1F9D3}",
  older_man: "\u{1F474}",
  older_woman: "\u{1F475}",
  person_frowning: "\u{1F64D}",
  "man-frowning": "\u{1F64D}\u200D\u2642\uFE0F",
  "woman-frowning": "\u{1F64D}\u200D\u2640\uFE0F",
  person_with_pouting_face: "\u{1F64E}",
  "man-pouting": "\u{1F64E}\u200D\u2642\uFE0F",
  "woman-pouting": "\u{1F64E}\u200D\u2640\uFE0F",
  no_good: "\u{1F645}",
  "man-gesturing-no": "\u{1F645}\u200D\u2642\uFE0F",
  "woman-gesturing-no": "\u{1F645}\u200D\u2640\uFE0F",
  ok_woman: "\u{1F646}",
  "man-gesturing-ok": "\u{1F646}\u200D\u2642\uFE0F",
  "woman-gesturing-ok": "\u{1F646}\u200D\u2640\uFE0F",
  information_desk_person: "\u{1F481}",
  "man-tipping-hand": "\u{1F481}\u200D\u2642\uFE0F",
  "woman-tipping-hand": "\u{1F481}\u200D\u2640\uFE0F",
  raising_hand: "\u{1F64B}",
  "man-raising-hand": "\u{1F64B}\u200D\u2642\uFE0F",
  "woman-raising-hand": "\u{1F64B}\u200D\u2640\uFE0F",
  deaf_person: "\u{1F9CF}",
  deaf_man: "\u{1F9CF}\u200D\u2642\uFE0F",
  deaf_woman: "\u{1F9CF}\u200D\u2640\uFE0F",
  bow: "\u{1F647}",
  "man-bowing": "\u{1F647}\u200D\u2642\uFE0F",
  "woman-bowing": "\u{1F647}\u200D\u2640\uFE0F",
  face_palm: "\u{1F926}",
  "man-facepalming": "\u{1F926}\u200D\u2642\uFE0F",
  "woman-facepalming": "\u{1F926}\u200D\u2640\uFE0F",
  shrug: "\u{1F937}",
  "man-shrugging": "\u{1F937}\u200D\u2642\uFE0F",
  "woman-shrugging": "\u{1F937}\u200D\u2640\uFE0F",
  health_worker: "\u{1F9D1}\u200D\u2695\uFE0F",
  "male-doctor": "\u{1F468}\u200D\u2695\uFE0F",
  "female-doctor": "\u{1F469}\u200D\u2695\uFE0F",
  student: "\u{1F9D1}\u200D\u{1F393}",
  "male-student": "\u{1F468}\u200D\u{1F393}",
  "female-student": "\u{1F469}\u200D\u{1F393}",
  teacher: "\u{1F9D1}\u200D\u{1F3EB}",
  "male-teacher": "\u{1F468}\u200D\u{1F3EB}",
  "female-teacher": "\u{1F469}\u200D\u{1F3EB}",
  judge: "\u{1F9D1}\u200D\u2696\uFE0F",
  "male-judge": "\u{1F468}\u200D\u2696\uFE0F",
  "female-judge": "\u{1F469}\u200D\u2696\uFE0F",
  farmer: "\u{1F9D1}\u200D\u{1F33E}",
  "male-farmer": "\u{1F468}\u200D\u{1F33E}",
  "female-farmer": "\u{1F469}\u200D\u{1F33E}",
  cook: "\u{1F9D1}\u200D\u{1F373}",
  "male-cook": "\u{1F468}\u200D\u{1F373}",
  "female-cook": "\u{1F469}\u200D\u{1F373}",
  mechanic: "\u{1F9D1}\u200D\u{1F527}",
  "male-mechanic": "\u{1F468}\u200D\u{1F527}",
  "female-mechanic": "\u{1F469}\u200D\u{1F527}",
  factory_worker: "\u{1F9D1}\u200D\u{1F3ED}",
  "male-factory-worker": "\u{1F468}\u200D\u{1F3ED}",
  "female-factory-worker": "\u{1F469}\u200D\u{1F3ED}",
  office_worker: "\u{1F9D1}\u200D\u{1F4BC}",
  "male-office-worker": "\u{1F468}\u200D\u{1F4BC}",
  "female-office-worker": "\u{1F469}\u200D\u{1F4BC}",
  scientist: "\u{1F9D1}\u200D\u{1F52C}",
  "male-scientist": "\u{1F468}\u200D\u{1F52C}",
  "female-scientist": "\u{1F469}\u200D\u{1F52C}",
  technologist: "\u{1F9D1}\u200D\u{1F4BB}",
  "male-technologist": "\u{1F468}\u200D\u{1F4BB}",
  "female-technologist": "\u{1F469}\u200D\u{1F4BB}",
  singer: "\u{1F9D1}\u200D\u{1F3A4}",
  "male-singer": "\u{1F468}\u200D\u{1F3A4}",
  "female-singer": "\u{1F469}\u200D\u{1F3A4}",
  artist: "\u{1F9D1}\u200D\u{1F3A8}",
  "male-artist": "\u{1F468}\u200D\u{1F3A8}",
  "female-artist": "\u{1F469}\u200D\u{1F3A8}",
  pilot: "\u{1F9D1}\u200D\u2708\uFE0F",
  "male-pilot": "\u{1F468}\u200D\u2708\uFE0F",
  "female-pilot": "\u{1F469}\u200D\u2708\uFE0F",
  astronaut: "\u{1F9D1}\u200D\u{1F680}",
  "male-astronaut": "\u{1F468}\u200D\u{1F680}",
  "female-astronaut": "\u{1F469}\u200D\u{1F680}",
  firefighter: "\u{1F9D1}\u200D\u{1F692}",
  "male-firefighter": "\u{1F468}\u200D\u{1F692}",
  "female-firefighter": "\u{1F469}\u200D\u{1F692}",
  cop: "\u{1F46E}",
  "male-police-officer": "\u{1F46E}\u200D\u2642\uFE0F",
  "female-police-officer": "\u{1F46E}\u200D\u2640\uFE0F",
  sleuth_or_spy: "\u{1F575}\uFE0F",
  "male-detective": "\u{1F575}\uFE0F\u200D\u2642\uFE0F",
  "female-detective": "\u{1F575}\uFE0F\u200D\u2640\uFE0F",
  guardsman: "\u{1F482}",
  "male-guard": "\u{1F482}\u200D\u2642\uFE0F",
  "female-guard": "\u{1F482}\u200D\u2640\uFE0F",
  ninja: "\u{1F977}",
  construction_worker: "\u{1F477}",
  "male-construction-worker": "\u{1F477}\u200D\u2642\uFE0F",
  "female-construction-worker": "\u{1F477}\u200D\u2640\uFE0F",
  person_with_crown: "\u{1FAC5}",
  prince: "\u{1F934}",
  princess: "\u{1F478}",
  man_with_turban: "\u{1F473}",
  "man-wearing-turban": "\u{1F473}\u200D\u2642\uFE0F",
  "woman-wearing-turban": "\u{1F473}\u200D\u2640\uFE0F",
  man_with_gua_pi_mao: "\u{1F472}",
  person_with_headscarf: "\u{1F9D5}",
  person_in_tuxedo: "\u{1F935}",
  man_in_tuxedo: "\u{1F935}\u200D\u2642\uFE0F",
  woman_in_tuxedo: "\u{1F935}\u200D\u2640\uFE0F",
  bride_with_veil: "\u{1F470}",
  man_with_veil: "\u{1F470}\u200D\u2642\uFE0F",
  woman_with_veil: "\u{1F470}\u200D\u2640\uFE0F",
  pregnant_woman: "\u{1F930}",
  pregnant_man: "\u{1FAC3}",
  pregnant_person: "\u{1FAC4}",
  "breast-feeding": "\u{1F931}",
  woman_feeding_baby: "\u{1F469}\u200D\u{1F37C}",
  man_feeding_baby: "\u{1F468}\u200D\u{1F37C}",
  person_feeding_baby: "\u{1F9D1}\u200D\u{1F37C}",
  angel: "\u{1F47C}",
  santa: "\u{1F385}",
  mrs_claus: "\u{1F936}",
  mx_claus: "\u{1F9D1}\u200D\u{1F384}",
  superhero: "\u{1F9B8}",
  male_superhero: "\u{1F9B8}\u200D\u2642\uFE0F",
  female_superhero: "\u{1F9B8}\u200D\u2640\uFE0F",
  supervillain: "\u{1F9B9}",
  male_supervillain: "\u{1F9B9}\u200D\u2642\uFE0F",
  female_supervillain: "\u{1F9B9}\u200D\u2640\uFE0F",
  mage: "\u{1F9D9}",
  male_mage: "\u{1F9D9}\u200D\u2642\uFE0F",
  female_mage: "\u{1F9D9}\u200D\u2640\uFE0F",
  fairy: "\u{1F9DA}",
  male_fairy: "\u{1F9DA}\u200D\u2642\uFE0F",
  female_fairy: "\u{1F9DA}\u200D\u2640\uFE0F",
  vampire: "\u{1F9DB}",
  male_vampire: "\u{1F9DB}\u200D\u2642\uFE0F",
  female_vampire: "\u{1F9DB}\u200D\u2640\uFE0F",
  merperson: "\u{1F9DC}",
  merman: "\u{1F9DC}\u200D\u2642\uFE0F",
  mermaid: "\u{1F9DC}\u200D\u2640\uFE0F",
  elf: "\u{1F9DD}",
  male_elf: "\u{1F9DD}\u200D\u2642\uFE0F",
  female_elf: "\u{1F9DD}\u200D\u2640\uFE0F",
  genie: "\u{1F9DE}",
  male_genie: "\u{1F9DE}\u200D\u2642\uFE0F",
  female_genie: "\u{1F9DE}\u200D\u2640\uFE0F",
  zombie: "\u{1F9DF}",
  male_zombie: "\u{1F9DF}\u200D\u2642\uFE0F",
  female_zombie: "\u{1F9DF}\u200D\u2640\uFE0F",
  troll: "\u{1F9CC}",
  massage: "\u{1F486}",
  "man-getting-massage": "\u{1F486}\u200D\u2642\uFE0F",
  "woman-getting-massage": "\u{1F486}\u200D\u2640\uFE0F",
  haircut: "\u{1F487}",
  "man-getting-haircut": "\u{1F487}\u200D\u2642\uFE0F",
  "woman-getting-haircut": "\u{1F487}\u200D\u2640\uFE0F",
  walking: "\u{1F6B6}",
  "man-walking": "\u{1F6B6}\u200D\u2642\uFE0F",
  "woman-walking": "\u{1F6B6}\u200D\u2640\uFE0F",
  standing_person: "\u{1F9CD}",
  man_standing: "\u{1F9CD}\u200D\u2642\uFE0F",
  woman_standing: "\u{1F9CD}\u200D\u2640\uFE0F",
  kneeling_person: "\u{1F9CE}",
  man_kneeling: "\u{1F9CE}\u200D\u2642\uFE0F",
  woman_kneeling: "\u{1F9CE}\u200D\u2640\uFE0F",
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
  "man-running": "\u{1F3C3}\u200D\u2642\uFE0F",
  "woman-running": "\u{1F3C3}\u200D\u2640\uFE0F",
  dancer: "\u{1F483}",
  man_dancing: "\u{1F57A}",
  man_in_business_suit_levitating: "\u{1F574}\uFE0F",
  dancers: "\u{1F46F}",
  "men-with-bunny-ears-partying": "\u{1F46F}\u200D\u2642\uFE0F",
  "women-with-bunny-ears-partying": "\u{1F46F}\u200D\u2640\uFE0F",
  person_in_steamy_room: "\u{1F9D6}",
  man_in_steamy_room: "\u{1F9D6}\u200D\u2642\uFE0F",
  woman_in_steamy_room: "\u{1F9D6}\u200D\u2640\uFE0F",
  person_climbing: "\u{1F9D7}",
  man_climbing: "\u{1F9D7}\u200D\u2642\uFE0F",
  woman_climbing: "\u{1F9D7}\u200D\u2640\uFE0F",
  fencer: "\u{1F93A}",
  horse_racing: "\u{1F3C7}",
  skier: "\u26F7\uFE0F",
  snowboarder: "\u{1F3C2}",
  golfer: "\u{1F3CC}\uFE0F",
  "man-golfing": "\u{1F3CC}\uFE0F\u200D\u2642\uFE0F",
  "woman-golfing": "\u{1F3CC}\uFE0F\u200D\u2640\uFE0F",
  surfer: "\u{1F3C4}",
  "man-surfing": "\u{1F3C4}\u200D\u2642\uFE0F",
  "woman-surfing": "\u{1F3C4}\u200D\u2640\uFE0F",
  rowboat: "\u{1F6A3}",
  "man-rowing-boat": "\u{1F6A3}\u200D\u2642\uFE0F",
  "woman-rowing-boat": "\u{1F6A3}\u200D\u2640\uFE0F",
  swimmer: "\u{1F3CA}",
  "man-swimming": "\u{1F3CA}\u200D\u2642\uFE0F",
  "woman-swimming": "\u{1F3CA}\u200D\u2640\uFE0F",
  person_with_ball: "\u26F9\uFE0F",
  "man-bouncing-ball": "\u26F9\uFE0F\u200D\u2642\uFE0F",
  "woman-bouncing-ball": "\u26F9\uFE0F\u200D\u2640\uFE0F",
  weight_lifter: "\u{1F3CB}\uFE0F",
  "man-lifting-weights": "\u{1F3CB}\uFE0F\u200D\u2642\uFE0F",
  "woman-lifting-weights": "\u{1F3CB}\uFE0F\u200D\u2640\uFE0F",
  bicyclist: "\u{1F6B4}",
  "man-biking": "\u{1F6B4}\u200D\u2642\uFE0F",
  "woman-biking": "\u{1F6B4}\u200D\u2640\uFE0F",
  mountain_bicyclist: "\u{1F6B5}",
  "man-mountain-biking": "\u{1F6B5}\u200D\u2642\uFE0F",
  "woman-mountain-biking": "\u{1F6B5}\u200D\u2640\uFE0F",
  person_doing_cartwheel: "\u{1F938}",
  "man-cartwheeling": "\u{1F938}\u200D\u2642\uFE0F",
  "woman-cartwheeling": "\u{1F938}\u200D\u2640\uFE0F",
  wrestlers: "\u{1F93C}",
  "man-wrestling": "\u{1F93C}\u200D\u2642\uFE0F",
  "woman-wrestling": "\u{1F93C}\u200D\u2640\uFE0F",
  water_polo: "\u{1F93D}",
  "man-playing-water-polo": "\u{1F93D}\u200D\u2642\uFE0F",
  "woman-playing-water-polo": "\u{1F93D}\u200D\u2640\uFE0F",
  handball: "\u{1F93E}",
  "man-playing-handball": "\u{1F93E}\u200D\u2642\uFE0F",
  "woman-playing-handball": "\u{1F93E}\u200D\u2640\uFE0F",
  juggling: "\u{1F939}",
  "man-juggling": "\u{1F939}\u200D\u2642\uFE0F",
  "woman-juggling": "\u{1F939}\u200D\u2640\uFE0F",
  person_in_lotus_position: "\u{1F9D8}",
  man_in_lotus_position: "\u{1F9D8}\u200D\u2642\uFE0F",
  woman_in_lotus_position: "\u{1F9D8}\u200D\u2640\uFE0F",
  bath: "\u{1F6C0}",
  sleeping_accommodation: "\u{1F6CC}",
  people_holding_hands: "\u{1F9D1}\u200D\u{1F91D}\u200D\u{1F9D1}",
  two_women_holding_hands: "\u{1F46D}",
  man_and_woman_holding_hands: "\u{1F46B}",
  two_men_holding_hands: "\u{1F46C}",
  couplekiss: "\u{1F48F}",
  "woman-kiss-man": "\u{1F469}\u200D\u2764\uFE0F\u200D\u{1F48B}\u200D\u{1F468}",
  "man-kiss-man": "\u{1F468}\u200D\u2764\uFE0F\u200D\u{1F48B}\u200D\u{1F468}",
  "woman-kiss-woman": "\u{1F469}\u200D\u2764\uFE0F\u200D\u{1F48B}\u200D\u{1F469}",
  couple_with_heart: "\u{1F491}",
  "woman-heart-man": "\u{1F469}\u200D\u2764\uFE0F\u200D\u{1F468}",
  "man-heart-man": "\u{1F468}\u200D\u2764\uFE0F\u200D\u{1F468}",
  "woman-heart-woman": "\u{1F469}\u200D\u2764\uFE0F\u200D\u{1F469}",
  family: "\u{1F46A}",
  "man-woman-boy": "\u{1F468}\u200D\u{1F469}\u200D\u{1F466}",
  "man-woman-girl": "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}",
  "man-woman-girl-boy": "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}\u200D\u{1F466}",
  "man-woman-boy-boy": "\u{1F468}\u200D\u{1F469}\u200D\u{1F466}\u200D\u{1F466}",
  "man-woman-girl-girl": "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}\u200D\u{1F467}",
  "man-man-boy": "\u{1F468}\u200D\u{1F468}\u200D\u{1F466}",
  "man-man-girl": "\u{1F468}\u200D\u{1F468}\u200D\u{1F467}",
  "man-man-girl-boy": "\u{1F468}\u200D\u{1F468}\u200D\u{1F467}\u200D\u{1F466}",
  "man-man-boy-boy": "\u{1F468}\u200D\u{1F468}\u200D\u{1F466}\u200D\u{1F466}",
  "man-man-girl-girl": "\u{1F468}\u200D\u{1F468}\u200D\u{1F467}\u200D\u{1F467}",
  "woman-woman-boy": "\u{1F469}\u200D\u{1F469}\u200D\u{1F466}",
  "woman-woman-girl": "\u{1F469}\u200D\u{1F469}\u200D\u{1F467}",
  "woman-woman-girl-boy": "\u{1F469}\u200D\u{1F469}\u200D\u{1F467}\u200D\u{1F466}",
  "woman-woman-boy-boy": "\u{1F469}\u200D\u{1F469}\u200D\u{1F466}\u200D\u{1F466}",
  "woman-woman-girl-girl": "\u{1F469}\u200D\u{1F469}\u200D\u{1F467}\u200D\u{1F467}",
  "man-boy": "\u{1F468}\u200D\u{1F466}",
  "man-boy-boy": "\u{1F468}\u200D\u{1F466}\u200D\u{1F466}",
  "man-girl": "\u{1F468}\u200D\u{1F467}",
  "man-girl-boy": "\u{1F468}\u200D\u{1F467}\u200D\u{1F466}",
  "man-girl-girl": "\u{1F468}\u200D\u{1F467}\u200D\u{1F467}",
  "woman-boy": "\u{1F469}\u200D\u{1F466}",
  "woman-boy-boy": "\u{1F469}\u200D\u{1F466}\u200D\u{1F466}",
  "woman-girl": "\u{1F469}\u200D\u{1F467}",
  "woman-girl-boy": "\u{1F469}\u200D\u{1F467}\u200D\u{1F466}",
  "woman-girl-girl": "\u{1F469}\u200D\u{1F467}\u200D\u{1F467}",
  speaking_head_in_silhouette: "\u{1F5E3}\uFE0F",
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
  lion_face: "\u{1F981}",
  tiger: "\u{1F42F}",
  tiger2: "\u{1F405}",
  leopard: "\u{1F406}",
  horse: "\u{1F434}",
  racehorse: "\u{1F40E}",
  unicorn_face: "\u{1F984}",
  zebra_face: "\u{1F993}",
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
  giraffe_face: "\u{1F992}",
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
  turkey: "\u{1F983}",
  chicken: "\u{1F414}",
  rooster: "\u{1F413}",
  hatching_chick: "\u{1F423}",
  baby_chick: "\u{1F424}",
  hatched_chick: "\u{1F425}",
  bird: "\u{1F426}",
  penguin: "\u{1F427}",
  dove_of_peace: "\u{1F54A}\uFE0F",
  eagle: "\u{1F985}",
  duck: "\u{1F986}",
  swan: "\u{1F9A2}",
  owl: "\u{1F989}",
  dodo: "\u{1F9A4}",
  feather: "\u{1FAB6}",
  flamingo: "\u{1F9A9}",
  peacock: "\u{1F99A}",
  parrot: "\u{1F99C}",
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
  seal: "\u{1F9AD}",
  fish: "\u{1F41F}",
  tropical_fish: "\u{1F420}",
  blowfish: "\u{1F421}",
  shark: "\u{1F988}",
  octopus: "\u{1F419}",
  shell: "\u{1F41A}",
  coral: "\u{1FAB8}",
  snail: "\u{1F40C}",
  butterfly: "\u{1F98B}",
  bug: "\u{1F41B}",
  ant: "\u{1F41C}",
  bee: "\u{1F41D}",
  beetle: "\u{1FAB2}",
  ladybug: "\u{1F41E}",
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
  kiwifruit: "\u{1F95D}",
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
  bread: "\u{1F35E}",
  croissant: "\u{1F950}",
  baguette_bread: "\u{1F956}",
  flatbread: "\u{1FAD3}",
  pretzel: "\u{1F968}",
  bagel: "\u{1F96F}",
  pancakes: "\u{1F95E}",
  waffle: "\u{1F9C7}",
  cheese_wedge: "\u{1F9C0}",
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
  glass_of_milk: "\u{1F95B}",
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
  mate_drink: "\u{1F9C9}",
  ice_cube: "\u{1F9CA}",
  chopsticks: "\u{1F962}",
  knife_fork_plate: "\u{1F37D}\uFE0F",
  fork_and_knife: "\u{1F374}",
  spoon: "\u{1F944}",
  hocho: "\u{1F52A}",
  jar: "\u{1FAD9}",
  amphora: "\u{1F3FA}",
  earth_africa: "\u{1F30D}",
  earth_americas: "\u{1F30E}",
  earth_asia: "\u{1F30F}",
  globe_with_meridians: "\u{1F310}",
  world_map: "\u{1F5FA}\uFE0F",
  japan: "\u{1F5FE}",
  compass: "\u{1F9ED}",
  snow_capped_mountain: "\u{1F3D4}\uFE0F",
  mountain: "\u26F0\uFE0F",
  volcano: "\u{1F30B}",
  mount_fuji: "\u{1F5FB}",
  camping: "\u{1F3D5}\uFE0F",
  beach_with_umbrella: "\u{1F3D6}\uFE0F",
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
  house_buildings: "\u{1F3D8}\uFE0F",
  derelict_house_building: "\u{1F3DA}\uFE0F",
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
  oncoming_automobile: "\u{1F698}",
  blue_car: "\u{1F699}",
  pickup_truck: "\u{1F6FB}",
  truck: "\u{1F69A}",
  articulated_lorry: "\u{1F69B}",
  tractor: "\u{1F69C}",
  racing_car: "\u{1F3CE}\uFE0F",
  racing_motorcycle: "\u{1F3CD}\uFE0F",
  motor_scooter: "\u{1F6F5}",
  manual_wheelchair: "\u{1F9BD}",
  motorized_wheelchair: "\u{1F9BC}",
  auto_rickshaw: "\u{1F6FA}",
  bike: "\u{1F6B2}",
  scooter: "\u{1F6F4}",
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
  octagonal_sign: "\u{1F6D1}",
  construction: "\u{1F6A7}",
  anchor: "\u2693",
  ring_buoy: "\u{1F6DF}",
  boat: "\u26F5",
  canoe: "\u{1F6F6}",
  speedboat: "\u{1F6A4}",
  passenger_ship: "\u{1F6F3}\uFE0F",
  ferry: "\u26F4\uFE0F",
  motor_boat: "\u{1F6E5}\uFE0F",
  ship: "\u{1F6A2}",
  airplane: "\u2708\uFE0F",
  small_airplane: "\u{1F6E9}\uFE0F",
  airplane_departure: "\u{1F6EB}",
  airplane_arriving: "\u{1F6EC}",
  parachute: "\u{1FA82}",
  seat: "\u{1F4BA}",
  helicopter: "\u{1F681}",
  suspension_railway: "\u{1F69F}",
  mountain_cableway: "\u{1F6A0}",
  aerial_tramway: "\u{1F6A1}",
  satellite: "\u{1F6F0}\uFE0F",
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
  thunder_cloud_and_rain: "\u26C8\uFE0F",
  mostly_sunny: "\u{1F324}\uFE0F",
  barely_sunny: "\u{1F325}\uFE0F",
  partly_sunny_rain: "\u{1F326}\uFE0F",
  rain_cloud: "\u{1F327}\uFE0F",
  snow_cloud: "\u{1F328}\uFE0F",
  lightning: "\u{1F329}\uFE0F",
  tornado: "\u{1F32A}\uFE0F",
  fog: "\u{1F32B}\uFE0F",
  wind_blowing_face: "\u{1F32C}\uFE0F",
  cyclone: "\u{1F300}",
  rainbow: "\u{1F308}",
  closed_umbrella: "\u{1F302}",
  umbrella: "\u2602\uFE0F",
  umbrella_with_rain_drops: "\u2614",
  umbrella_on_ground: "\u26F1\uFE0F",
  zap: "\u26A1",
  snowflake: "\u2744\uFE0F",
  snowman: "\u2603\uFE0F",
  snowman_without_snow: "\u26C4",
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
  admission_tickets: "\u{1F39F}\uFE0F",
  ticket: "\u{1F3AB}",
  medal: "\u{1F396}\uFE0F",
  trophy: "\u{1F3C6}",
  sports_medal: "\u{1F3C5}",
  first_place_medal: "\u{1F947}",
  second_place_medal: "\u{1F948}",
  third_place_medal: "\u{1F949}",
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
  cricket_bat_and_ball: "\u{1F3CF}",
  field_hockey_stick_and_ball: "\u{1F3D1}",
  ice_hockey_stick_and_puck: "\u{1F3D2}",
  lacrosse: "\u{1F94D}",
  table_tennis_paddle_and_ball: "\u{1F3D3}",
  badminton_racquet_and_shuttlecock: "\u{1F3F8}",
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
  "yo-yo": "\u{1FA80}",
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
  frame_with_picture: "\u{1F5BC}\uFE0F",
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
  jeans: "\u{1F456}",
  scarf: "\u{1F9E3}",
  gloves: "\u{1F9E4}",
  coat: "\u{1F9E5}",
  socks: "\u{1F9E6}",
  dress: "\u{1F457}",
  kimono: "\u{1F458}",
  sari: "\u{1F97B}",
  "one-piece_swimsuit": "\u{1FA71}",
  briefs: "\u{1FA72}",
  shorts: "\u{1FA73}",
  bikini: "\u{1F459}",
  womans_clothes: "\u{1F45A}",
  purse: "\u{1F45B}",
  handbag: "\u{1F45C}",
  pouch: "\u{1F45D}",
  shopping_bags: "\u{1F6CD}\uFE0F",
  school_satchel: "\u{1F392}",
  thong_sandal: "\u{1FA74}",
  mans_shoe: "\u{1F45E}",
  athletic_shoe: "\u{1F45F}",
  hiking_boot: "\u{1F97E}",
  womans_flat_shoe: "\u{1F97F}",
  high_heel: "\u{1F460}",
  sandal: "\u{1F461}",
  ballet_shoes: "\u{1FA70}",
  boot: "\u{1F462}",
  crown: "\u{1F451}",
  womans_hat: "\u{1F452}",
  tophat: "\u{1F3A9}",
  mortar_board: "\u{1F393}",
  billed_cap: "\u{1F9E2}",
  military_helmet: "\u{1FA96}",
  helmet_with_white_cross: "\u26D1\uFE0F",
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
  drum_with_drumsticks: "\u{1F941}",
  long_drum: "\u{1FA98}",
  iphone: "\u{1F4F1}",
  calling: "\u{1F4F2}",
  phone: "\u260E\uFE0F",
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
  three_button_mouse: "\u{1F5B1}\uFE0F",
  trackball: "\u{1F5B2}\uFE0F",
  minidisc: "\u{1F4BD}",
  floppy_disk: "\u{1F4BE}",
  cd: "\u{1F4BF}",
  dvd: "\u{1F4C0}",
  abacus: "\u{1F9EE}",
  movie_camera: "\u{1F3A5}",
  film_frames: "\u{1F39E}\uFE0F",
  film_projector: "\u{1F4FD}\uFE0F",
  clapper: "\u{1F3AC}",
  tv: "\u{1F4FA}",
  camera: "\u{1F4F7}",
  camera_with_flash: "\u{1F4F8}",
  video_camera: "\u{1F4F9}",
  vhs: "\u{1F4FC}",
  mag: "\u{1F50D}",
  mag_right: "\u{1F50E}",
  candle: "\u{1F56F}\uFE0F",
  bulb: "\u{1F4A1}",
  flashlight: "\u{1F526}",
  izakaya_lantern: "\u{1F3EE}",
  diya_lamp: "\u{1FA94}",
  notebook_with_decorative_cover: "\u{1F4D4}",
  closed_book: "\u{1F4D5}",
  book: "\u{1F4D6}",
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
  rolled_up_newspaper: "\u{1F5DE}\uFE0F",
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
  email: "\u2709\uFE0F",
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
  ballot_box_with_ballot: "\u{1F5F3}\uFE0F",
  pencil2: "\u270F\uFE0F",
  black_nib: "\u2712\uFE0F",
  lower_left_fountain_pen: "\u{1F58B}\uFE0F",
  lower_left_ballpoint_pen: "\u{1F58A}\uFE0F",
  lower_left_paintbrush: "\u{1F58C}\uFE0F",
  lower_left_crayon: "\u{1F58D}\uFE0F",
  memo: "\u{1F4DD}",
  briefcase: "\u{1F4BC}",
  file_folder: "\u{1F4C1}",
  open_file_folder: "\u{1F4C2}",
  card_index_dividers: "\u{1F5C2}\uFE0F",
  date: "\u{1F4C5}",
  calendar: "\u{1F4C6}",
  spiral_note_pad: "\u{1F5D2}\uFE0F",
  spiral_calendar_pad: "\u{1F5D3}\uFE0F",
  card_index: "\u{1F4C7}",
  chart_with_upwards_trend: "\u{1F4C8}",
  chart_with_downwards_trend: "\u{1F4C9}",
  bar_chart: "\u{1F4CA}",
  clipboard: "\u{1F4CB}",
  pushpin: "\u{1F4CC}",
  round_pushpin: "\u{1F4CD}",
  paperclip: "\u{1F4CE}",
  linked_paperclips: "\u{1F587}\uFE0F",
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
  dagger_knife: "\u{1F5E1}\uFE0F",
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
  compression: "\u{1F5DC}\uFE0F",
  scales: "\u2696\uFE0F",
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
  satellite_antenna: "\u{1F4E1}",
  syringe: "\u{1F489}",
  drop_of_blood: "\u{1FA78}",
  pill: "\u{1F48A}",
  adhesive_bandage: "\u{1FA79}",
  crutch: "\u{1FA7C}",
  stethoscope: "\u{1FA7A}",
  "x-ray": "\u{1FA7B}",
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
  shopping_trolley: "\u{1F6D2}",
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
  radioactive_sign: "\u2622\uFE0F",
  biohazard_sign: "\u2623\uFE0F",
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
  om_symbol: "\u{1F549}\uFE0F",
  star_of_david: "\u2721\uFE0F",
  wheel_of_dharma: "\u2638\uFE0F",
  yin_yang: "\u262F\uFE0F",
  latin_cross: "\u271D\uFE0F",
  orthodox_cross: "\u2626\uFE0F",
  star_and_crescent: "\u262A\uFE0F",
  peace_symbol: "\u262E\uFE0F",
  menorah_with_nine_branches: "\u{1F54E}",
  six_pointed_star: "\u{1F52F}",
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
  black_right_pointing_double_triangle_with_vertical_bar: "\u23ED\uFE0F",
  black_right_pointing_triangle_with_double_vertical_bar: "\u23EF\uFE0F",
  arrow_backward: "\u25C0\uFE0F",
  rewind: "\u23EA",
  black_left_pointing_double_triangle_with_vertical_bar: "\u23EE\uFE0F",
  arrow_up_small: "\u{1F53C}",
  arrow_double_up: "\u23EB",
  arrow_down_small: "\u{1F53D}",
  arrow_double_down: "\u23EC",
  double_vertical_bar: "\u23F8\uFE0F",
  black_square_for_stop: "\u23F9\uFE0F",
  black_circle_for_record: "\u23FA\uFE0F",
  eject: "\u23CF\uFE0F",
  cinema: "\u{1F3A6}",
  low_brightness: "\u{1F505}",
  high_brightness: "\u{1F506}",
  signal_strength: "\u{1F4F6}",
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
  keycap_star: "*\uFE0F\u20E3",
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
  large_orange_circle: "\u{1F7E0}",
  large_yellow_circle: "\u{1F7E1}",
  large_green_circle: "\u{1F7E2}",
  large_blue_circle: "\u{1F535}",
  large_purple_circle: "\u{1F7E3}",
  large_brown_circle: "\u{1F7E4}",
  black_circle: "\u26AB",
  white_circle: "\u26AA",
  large_red_square: "\u{1F7E5}",
  large_orange_square: "\u{1F7E7}",
  large_yellow_square: "\u{1F7E8}",
  large_green_square: "\u{1F7E9}",
  large_blue_square: "\u{1F7E6}",
  large_purple_square: "\u{1F7EA}",
  large_brown_square: "\u{1F7EB}",
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
  waving_black_flag: "\u{1F3F4}",
  waving_white_flag: "\u{1F3F3}\uFE0F",
  "rainbow-flag": "\u{1F3F3}\uFE0F\u200D\u{1F308}",
  transgender_flag: "\u{1F3F3}\uFE0F\u200D\u26A7\uFE0F",
  pirate_flag: "\u{1F3F4}\u200D\u2620\uFE0F",
  "flag-ac": "\u{1F1E6}\u{1F1E8}",
  "flag-ad": "\u{1F1E6}\u{1F1E9}",
  "flag-ae": "\u{1F1E6}\u{1F1EA}",
  "flag-af": "\u{1F1E6}\u{1F1EB}",
  "flag-ag": "\u{1F1E6}\u{1F1EC}",
  "flag-ai": "\u{1F1E6}\u{1F1EE}",
  "flag-al": "\u{1F1E6}\u{1F1F1}",
  "flag-am": "\u{1F1E6}\u{1F1F2}",
  "flag-ao": "\u{1F1E6}\u{1F1F4}",
  "flag-aq": "\u{1F1E6}\u{1F1F6}",
  "flag-ar": "\u{1F1E6}\u{1F1F7}",
  "flag-as": "\u{1F1E6}\u{1F1F8}",
  "flag-at": "\u{1F1E6}\u{1F1F9}",
  "flag-au": "\u{1F1E6}\u{1F1FA}",
  "flag-aw": "\u{1F1E6}\u{1F1FC}",
  "flag-ax": "\u{1F1E6}\u{1F1FD}",
  "flag-az": "\u{1F1E6}\u{1F1FF}",
  "flag-ba": "\u{1F1E7}\u{1F1E6}",
  "flag-bb": "\u{1F1E7}\u{1F1E7}",
  "flag-bd": "\u{1F1E7}\u{1F1E9}",
  "flag-be": "\u{1F1E7}\u{1F1EA}",
  "flag-bf": "\u{1F1E7}\u{1F1EB}",
  "flag-bg": "\u{1F1E7}\u{1F1EC}",
  "flag-bh": "\u{1F1E7}\u{1F1ED}",
  "flag-bi": "\u{1F1E7}\u{1F1EE}",
  "flag-bj": "\u{1F1E7}\u{1F1EF}",
  "flag-bl": "\u{1F1E7}\u{1F1F1}",
  "flag-bm": "\u{1F1E7}\u{1F1F2}",
  "flag-bn": "\u{1F1E7}\u{1F1F3}",
  "flag-bo": "\u{1F1E7}\u{1F1F4}",
  "flag-bq": "\u{1F1E7}\u{1F1F6}",
  "flag-br": "\u{1F1E7}\u{1F1F7}",
  "flag-bs": "\u{1F1E7}\u{1F1F8}",
  "flag-bt": "\u{1F1E7}\u{1F1F9}",
  "flag-bv": "\u{1F1E7}\u{1F1FB}",
  "flag-bw": "\u{1F1E7}\u{1F1FC}",
  "flag-by": "\u{1F1E7}\u{1F1FE}",
  "flag-bz": "\u{1F1E7}\u{1F1FF}",
  "flag-ca": "\u{1F1E8}\u{1F1E6}",
  "flag-cc": "\u{1F1E8}\u{1F1E8}",
  "flag-cd": "\u{1F1E8}\u{1F1E9}",
  "flag-cf": "\u{1F1E8}\u{1F1EB}",
  "flag-cg": "\u{1F1E8}\u{1F1EC}",
  "flag-ch": "\u{1F1E8}\u{1F1ED}",
  "flag-ci": "\u{1F1E8}\u{1F1EE}",
  "flag-ck": "\u{1F1E8}\u{1F1F0}",
  "flag-cl": "\u{1F1E8}\u{1F1F1}",
  "flag-cm": "\u{1F1E8}\u{1F1F2}",
  cn: "\u{1F1E8}\u{1F1F3}",
  "flag-co": "\u{1F1E8}\u{1F1F4}",
  "flag-cp": "\u{1F1E8}\u{1F1F5}",
  "flag-cr": "\u{1F1E8}\u{1F1F7}",
  "flag-cu": "\u{1F1E8}\u{1F1FA}",
  "flag-cv": "\u{1F1E8}\u{1F1FB}",
  "flag-cw": "\u{1F1E8}\u{1F1FC}",
  "flag-cx": "\u{1F1E8}\u{1F1FD}",
  "flag-cy": "\u{1F1E8}\u{1F1FE}",
  "flag-cz": "\u{1F1E8}\u{1F1FF}",
  de: "\u{1F1E9}\u{1F1EA}",
  "flag-dg": "\u{1F1E9}\u{1F1EC}",
  "flag-dj": "\u{1F1E9}\u{1F1EF}",
  "flag-dk": "\u{1F1E9}\u{1F1F0}",
  "flag-dm": "\u{1F1E9}\u{1F1F2}",
  "flag-do": "\u{1F1E9}\u{1F1F4}",
  "flag-dz": "\u{1F1E9}\u{1F1FF}",
  "flag-ea": "\u{1F1EA}\u{1F1E6}",
  "flag-ec": "\u{1F1EA}\u{1F1E8}",
  "flag-ee": "\u{1F1EA}\u{1F1EA}",
  "flag-eg": "\u{1F1EA}\u{1F1EC}",
  "flag-eh": "\u{1F1EA}\u{1F1ED}",
  "flag-er": "\u{1F1EA}\u{1F1F7}",
  es: "\u{1F1EA}\u{1F1F8}",
  "flag-et": "\u{1F1EA}\u{1F1F9}",
  "flag-eu": "\u{1F1EA}\u{1F1FA}",
  "flag-fi": "\u{1F1EB}\u{1F1EE}",
  "flag-fj": "\u{1F1EB}\u{1F1EF}",
  "flag-fk": "\u{1F1EB}\u{1F1F0}",
  "flag-fm": "\u{1F1EB}\u{1F1F2}",
  "flag-fo": "\u{1F1EB}\u{1F1F4}",
  fr: "\u{1F1EB}\u{1F1F7}",
  "flag-ga": "\u{1F1EC}\u{1F1E6}",
  gb: "\u{1F1EC}\u{1F1E7}",
  "flag-gd": "\u{1F1EC}\u{1F1E9}",
  "flag-ge": "\u{1F1EC}\u{1F1EA}",
  "flag-gf": "\u{1F1EC}\u{1F1EB}",
  "flag-gg": "\u{1F1EC}\u{1F1EC}",
  "flag-gh": "\u{1F1EC}\u{1F1ED}",
  "flag-gi": "\u{1F1EC}\u{1F1EE}",
  "flag-gl": "\u{1F1EC}\u{1F1F1}",
  "flag-gm": "\u{1F1EC}\u{1F1F2}",
  "flag-gn": "\u{1F1EC}\u{1F1F3}",
  "flag-gp": "\u{1F1EC}\u{1F1F5}",
  "flag-gq": "\u{1F1EC}\u{1F1F6}",
  "flag-gr": "\u{1F1EC}\u{1F1F7}",
  "flag-gs": "\u{1F1EC}\u{1F1F8}",
  "flag-gt": "\u{1F1EC}\u{1F1F9}",
  "flag-gu": "\u{1F1EC}\u{1F1FA}",
  "flag-gw": "\u{1F1EC}\u{1F1FC}",
  "flag-gy": "\u{1F1EC}\u{1F1FE}",
  "flag-hk": "\u{1F1ED}\u{1F1F0}",
  "flag-hm": "\u{1F1ED}\u{1F1F2}",
  "flag-hn": "\u{1F1ED}\u{1F1F3}",
  "flag-hr": "\u{1F1ED}\u{1F1F7}",
  "flag-ht": "\u{1F1ED}\u{1F1F9}",
  "flag-hu": "\u{1F1ED}\u{1F1FA}",
  "flag-ic": "\u{1F1EE}\u{1F1E8}",
  "flag-id": "\u{1F1EE}\u{1F1E9}",
  "flag-ie": "\u{1F1EE}\u{1F1EA}",
  "flag-il": "\u{1F1EE}\u{1F1F1}",
  "flag-im": "\u{1F1EE}\u{1F1F2}",
  "flag-in": "\u{1F1EE}\u{1F1F3}",
  "flag-io": "\u{1F1EE}\u{1F1F4}",
  "flag-iq": "\u{1F1EE}\u{1F1F6}",
  "flag-ir": "\u{1F1EE}\u{1F1F7}",
  "flag-is": "\u{1F1EE}\u{1F1F8}",
  it: "\u{1F1EE}\u{1F1F9}",
  "flag-je": "\u{1F1EF}\u{1F1EA}",
  "flag-jm": "\u{1F1EF}\u{1F1F2}",
  "flag-jo": "\u{1F1EF}\u{1F1F4}",
  jp: "\u{1F1EF}\u{1F1F5}",
  "flag-ke": "\u{1F1F0}\u{1F1EA}",
  "flag-kg": "\u{1F1F0}\u{1F1EC}",
  "flag-kh": "\u{1F1F0}\u{1F1ED}",
  "flag-ki": "\u{1F1F0}\u{1F1EE}",
  "flag-km": "\u{1F1F0}\u{1F1F2}",
  "flag-kn": "\u{1F1F0}\u{1F1F3}",
  "flag-kp": "\u{1F1F0}\u{1F1F5}",
  kr: "\u{1F1F0}\u{1F1F7}",
  "flag-kw": "\u{1F1F0}\u{1F1FC}",
  "flag-ky": "\u{1F1F0}\u{1F1FE}",
  "flag-kz": "\u{1F1F0}\u{1F1FF}",
  "flag-la": "\u{1F1F1}\u{1F1E6}",
  "flag-lb": "\u{1F1F1}\u{1F1E7}",
  "flag-lc": "\u{1F1F1}\u{1F1E8}",
  "flag-li": "\u{1F1F1}\u{1F1EE}",
  "flag-lk": "\u{1F1F1}\u{1F1F0}",
  "flag-lr": "\u{1F1F1}\u{1F1F7}",
  "flag-ls": "\u{1F1F1}\u{1F1F8}",
  "flag-lt": "\u{1F1F1}\u{1F1F9}",
  "flag-lu": "\u{1F1F1}\u{1F1FA}",
  "flag-lv": "\u{1F1F1}\u{1F1FB}",
  "flag-ly": "\u{1F1F1}\u{1F1FE}",
  "flag-ma": "\u{1F1F2}\u{1F1E6}",
  "flag-mc": "\u{1F1F2}\u{1F1E8}",
  "flag-md": "\u{1F1F2}\u{1F1E9}",
  "flag-me": "\u{1F1F2}\u{1F1EA}",
  "flag-mf": "\u{1F1F2}\u{1F1EB}",
  "flag-mg": "\u{1F1F2}\u{1F1EC}",
  "flag-mh": "\u{1F1F2}\u{1F1ED}",
  "flag-mk": "\u{1F1F2}\u{1F1F0}",
  "flag-ml": "\u{1F1F2}\u{1F1F1}",
  "flag-mm": "\u{1F1F2}\u{1F1F2}",
  "flag-mn": "\u{1F1F2}\u{1F1F3}",
  "flag-mo": "\u{1F1F2}\u{1F1F4}",
  "flag-mp": "\u{1F1F2}\u{1F1F5}",
  "flag-mq": "\u{1F1F2}\u{1F1F6}",
  "flag-mr": "\u{1F1F2}\u{1F1F7}",
  "flag-ms": "\u{1F1F2}\u{1F1F8}",
  "flag-mt": "\u{1F1F2}\u{1F1F9}",
  "flag-mu": "\u{1F1F2}\u{1F1FA}",
  "flag-mv": "\u{1F1F2}\u{1F1FB}",
  "flag-mw": "\u{1F1F2}\u{1F1FC}",
  "flag-mx": "\u{1F1F2}\u{1F1FD}",
  "flag-my": "\u{1F1F2}\u{1F1FE}",
  "flag-mz": "\u{1F1F2}\u{1F1FF}",
  "flag-na": "\u{1F1F3}\u{1F1E6}",
  "flag-nc": "\u{1F1F3}\u{1F1E8}",
  "flag-ne": "\u{1F1F3}\u{1F1EA}",
  "flag-nf": "\u{1F1F3}\u{1F1EB}",
  "flag-ng": "\u{1F1F3}\u{1F1EC}",
  "flag-ni": "\u{1F1F3}\u{1F1EE}",
  "flag-nl": "\u{1F1F3}\u{1F1F1}",
  "flag-no": "\u{1F1F3}\u{1F1F4}",
  "flag-np": "\u{1F1F3}\u{1F1F5}",
  "flag-nr": "\u{1F1F3}\u{1F1F7}",
  "flag-nu": "\u{1F1F3}\u{1F1FA}",
  "flag-nz": "\u{1F1F3}\u{1F1FF}",
  "flag-om": "\u{1F1F4}\u{1F1F2}",
  "flag-pa": "\u{1F1F5}\u{1F1E6}",
  "flag-pe": "\u{1F1F5}\u{1F1EA}",
  "flag-pf": "\u{1F1F5}\u{1F1EB}",
  "flag-pg": "\u{1F1F5}\u{1F1EC}",
  "flag-ph": "\u{1F1F5}\u{1F1ED}",
  "flag-pk": "\u{1F1F5}\u{1F1F0}",
  "flag-pl": "\u{1F1F5}\u{1F1F1}",
  "flag-pm": "\u{1F1F5}\u{1F1F2}",
  "flag-pn": "\u{1F1F5}\u{1F1F3}",
  "flag-pr": "\u{1F1F5}\u{1F1F7}",
  "flag-ps": "\u{1F1F5}\u{1F1F8}",
  "flag-pt": "\u{1F1F5}\u{1F1F9}",
  "flag-pw": "\u{1F1F5}\u{1F1FC}",
  "flag-py": "\u{1F1F5}\u{1F1FE}",
  "flag-qa": "\u{1F1F6}\u{1F1E6}",
  "flag-re": "\u{1F1F7}\u{1F1EA}",
  "flag-ro": "\u{1F1F7}\u{1F1F4}",
  "flag-rs": "\u{1F1F7}\u{1F1F8}",
  ru: "\u{1F1F7}\u{1F1FA}",
  "flag-rw": "\u{1F1F7}\u{1F1FC}",
  "flag-sa": "\u{1F1F8}\u{1F1E6}",
  "flag-sb": "\u{1F1F8}\u{1F1E7}",
  "flag-sc": "\u{1F1F8}\u{1F1E8}",
  "flag-sd": "\u{1F1F8}\u{1F1E9}",
  "flag-se": "\u{1F1F8}\u{1F1EA}",
  "flag-sg": "\u{1F1F8}\u{1F1EC}",
  "flag-sh": "\u{1F1F8}\u{1F1ED}",
  "flag-si": "\u{1F1F8}\u{1F1EE}",
  "flag-sj": "\u{1F1F8}\u{1F1EF}",
  "flag-sk": "\u{1F1F8}\u{1F1F0}",
  "flag-sl": "\u{1F1F8}\u{1F1F1}",
  "flag-sm": "\u{1F1F8}\u{1F1F2}",
  "flag-sn": "\u{1F1F8}\u{1F1F3}",
  "flag-so": "\u{1F1F8}\u{1F1F4}",
  "flag-sr": "\u{1F1F8}\u{1F1F7}",
  "flag-ss": "\u{1F1F8}\u{1F1F8}",
  "flag-st": "\u{1F1F8}\u{1F1F9}",
  "flag-sv": "\u{1F1F8}\u{1F1FB}",
  "flag-sx": "\u{1F1F8}\u{1F1FD}",
  "flag-sy": "\u{1F1F8}\u{1F1FE}",
  "flag-sz": "\u{1F1F8}\u{1F1FF}",
  "flag-ta": "\u{1F1F9}\u{1F1E6}",
  "flag-tc": "\u{1F1F9}\u{1F1E8}",
  "flag-td": "\u{1F1F9}\u{1F1E9}",
  "flag-tf": "\u{1F1F9}\u{1F1EB}",
  "flag-tg": "\u{1F1F9}\u{1F1EC}",
  "flag-th": "\u{1F1F9}\u{1F1ED}",
  "flag-tj": "\u{1F1F9}\u{1F1EF}",
  "flag-tk": "\u{1F1F9}\u{1F1F0}",
  "flag-tl": "\u{1F1F9}\u{1F1F1}",
  "flag-tm": "\u{1F1F9}\u{1F1F2}",
  "flag-tn": "\u{1F1F9}\u{1F1F3}",
  "flag-to": "\u{1F1F9}\u{1F1F4}",
  "flag-tr": "\u{1F1F9}\u{1F1F7}",
  "flag-tt": "\u{1F1F9}\u{1F1F9}",
  "flag-tv": "\u{1F1F9}\u{1F1FB}",
  "flag-tw": "\u{1F1F9}\u{1F1FC}",
  "flag-tz": "\u{1F1F9}\u{1F1FF}",
  "flag-ua": "\u{1F1FA}\u{1F1E6}",
  "flag-ug": "\u{1F1FA}\u{1F1EC}",
  "flag-um": "\u{1F1FA}\u{1F1F2}",
  "flag-un": "\u{1F1FA}\u{1F1F3}",
  us: "\u{1F1FA}\u{1F1F8}",
  "flag-uy": "\u{1F1FA}\u{1F1FE}",
  "flag-uz": "\u{1F1FA}\u{1F1FF}",
  "flag-va": "\u{1F1FB}\u{1F1E6}",
  "flag-vc": "\u{1F1FB}\u{1F1E8}",
  "flag-ve": "\u{1F1FB}\u{1F1EA}",
  "flag-vg": "\u{1F1FB}\u{1F1EC}",
  "flag-vi": "\u{1F1FB}\u{1F1EE}",
  "flag-vn": "\u{1F1FB}\u{1F1F3}",
  "flag-vu": "\u{1F1FB}\u{1F1FA}",
  "flag-wf": "\u{1F1FC}\u{1F1EB}",
  "flag-ws": "\u{1F1FC}\u{1F1F8}",
  "flag-xk": "\u{1F1FD}\u{1F1F0}",
  "flag-ye": "\u{1F1FE}\u{1F1EA}",
  "flag-yt": "\u{1F1FE}\u{1F1F9}",
  "flag-za": "\u{1F1FF}\u{1F1E6}",
  "flag-zm": "\u{1F1FF}\u{1F1F2}",
  "flag-zw": "\u{1F1FF}\u{1F1FC}",
  "flag-england": "\u{1F3F4}\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F}",
  "flag-scotland": "\u{1F3F4}\u{E0067}\u{E0062}\u{E0073}\u{E0063}\u{E0074}\u{E007F}",
  "flag-wales": "\u{1F3F4}\u{E0067}\u{E0062}\u{E0077}\u{E006C}\u{E0073}\u{E007F}"
};

// src/format/linear-emoji.ts
var LINEAR_EMOJI = new Map(Object.entries(linear_emoji_default));

// src/format/markdown.ts
EditMap.prototype.consume = function consume(events) {
  this.map.sort((a, b) => a[0] - b[0]);
  const pieces = [];
  for (let index = this.map.length - 1; index >= 0; index--) {
    const [at, remove, add] = this.map[index];
    pieces.push(events.slice(at + remove), add);
    events.length = at;
  }
  for (let piece = pieces.pop(); piece !== void 0; piece = pieces.pop()) {
    for (const event of piece) events.push(event);
  }
  this.map.length = 0;
  this.index.clear();
};
var isAsciiAlphanumeric = (code) => code !== null && (code >= 48 && code <= 57 || code >= 65 && code <= 90 || code >= 97 && code <= 122);
var WORD_CODES = [43, 45, 46];
for (let code = 48; code <= 122; code++) if (isAsciiAlphanumeric(code)) WORD_CODES.push(code);
var UTF8 = new TextEncoder();
var AUTOLINK_OR_TAG = new RegExp([
  /<[A-Za-z][A-Za-z0-9+.-]{1,31}:[^\s<>]*>/.source,
  /<[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*>/.source,
  /<[A-Za-z][A-Za-z0-9-]*(?:\s+[A-Za-z_:][A-Za-z0-9_.:-]*(?:\s*=\s*(?:[^\s"'=<>`]+|'[^']*'|"[^"]*"))?)*\s*\/?>/.source,
  /<\/[A-Za-z][A-Za-z0-9-]*\s*>/.source
].join("|"), "y");

// src/mapping/front-matter.ts
function parseQuietly(yaml) {
  return (0, import_yaml.parse)(yaml, { logLevel: "error", prettyErrors: false });
}

// src/linear/facts.ts
var CONTENT_LIMIT = 25e4;
var LINEAR_FACTS = Object.freeze({
  mutationsReturnStoredContent: true,
  maxTitleLength: 512,
  maxContentLength: CONTENT_LIMIT,
  teamFilterIncludesProjectDocuments: false
});

// src/setup/hooks.ts
var PRE_COMMIT_CONFIG = ".pre-commit-config.yaml";
var SECURITY_ALIAS = "security";
var LOCAL_REPOS = /* @__PURE__ */ new Set(["local", "meta"]);
var PRE_COMMIT_HOOKS = "https://github.com/pre-commit/pre-commit-hooks";
var PRE_COMMIT_HOOKS_REV = "3e8a8703264a2f4a69428a0aa4dcb512790b2c8c";
function readHookConfig(text) {
  if (text === null) return { hooks: [] };
  let data;
  try {
    data = parseQuietly(text);
  } catch {
    return { hooks: [], invalid: message("setup.hooks-invalid-yaml", { file: PRE_COMMIT_CONFIG }) };
  }
  const repos = isRecord(data) ? data.repos : void 0;
  if (!Array.isArray(repos)) return { hooks: [], invalid: message("setup.hooks-no-repos", { file: PRE_COMMIT_CONFIG }) };
  const hooks = [];
  let securityBatchable = isRecord(data) && !Object.hasOwn(data, "<<") && !/!!merge|!<|%TAG/.test(text);
  for (const repo of repos) {
    if (!isRecord(repo)) continue;
    securityBatchable &&= !Object.hasOwn(repo, "<<");
    if (!Array.isArray(repo.hooks)) continue;
    const pinned = repo.repo === PRE_COMMIT_HOOKS && repo.rev === PRE_COMMIT_HOOKS_REV;
    const source = typeof repo.repo === "string" ? repo.repo : "";
    for (const hook of repo.hooks) {
      if (!isRecord(hook)) continue;
      securityBatchable &&= !Object.hasOwn(hook, "<<");
      if (typeof hook.id !== "string") continue;
      if (hook.alias === SECURITY_ALIAS || hook.id === SECURITY_ALIAS) {
        securityBatchable &&= fileLocalHook(source, pinned, hook);
      } else if (typeof hook.alias !== "string") {
        securityBatchable &&= LOCAL_REPOS.has(source) || pinned;
      }
      const command = [hook.entry, ...Array.isArray(hook.args) ? hook.args : []].filter((part) => typeof part === "string").join(" ");
      hooks.push({ id: hook.id, repo: source, ...typeof hook.alias === "string" ? { alias: hook.alias } : {}, ...command ? { command } : {} });
    }
  }
  return { hooks, securityBatchable };
}
function fileLocalHook(repo, pinned, hook) {
  const selection = ["id", "name", "alias", "description", "files", "exclude", "types", "types_or", "exclude_types", "stages", "require_serial", "verbose", "pass_filenames", "always_run"];
  if (hook.pass_filenames !== void 0 && hook.pass_filenames !== true) return false;
  if (hook.always_run !== void 0 && hook.always_run !== false) return false;
  if (repo === "local" && hook.language === "pygrep") {
    const entry = hook.entry;
    return typeof entry === "string" && (!entry.startsWith("-") || entry === "-----BEGIN (?:[A-Z0-9]+ )?PRIVATE KEY-----") && (hook.args === void 0 || Array.isArray(hook.args) && hook.args.every((arg) => ["-i", "--ignore-case", "--multiline", "--negate"].includes(arg))) && Object.keys(hook).every((key) => [...selection, "language", "entry", "args"].includes(key));
  }
  return pinned && hook.id === "detect-private-key" && Object.keys(hook).every((key) => selection.includes(key));
}
function securityHooks(config) {
  return config.hooks.filter((hook) => hook.alias === SECURITY_ALIAS).map((hook) => hook.id);
}
function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// src/sync/security.ts
import { spawn as spawn3 } from "node:child_process";
import { lstat, mkdtemp, mkdir, writeFile, readFile, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir as tmpdir2 } from "node:os";
import { dirname, join as join3, sep } from "node:path";
import { createHash as createHash2 } from "node:crypto";

// src/mapping/annotations.ts
var TEAM_KEY = "linear-team";
var PROJECT_KEY = "linear-project";
var MENTIONS_KEY = new RegExp(`^[ \\t]*["']?(?:${TEAM_KEY}|${PROJECT_KEY})["']?[ \\t]*:`, "m");

// src/mapping/blobs.ts
var MAPPING_FILE_BYTES = 4 * CONTENT_LIMIT;
var MAPPING_TREE_BYTES = 16 * 1024 * 1024;
var MAPPING_BUDGET_BYTES = 64 * 1024 * 1024;
var BATCH_BYTES = 4 * 1024 * 1024;

// src/mapping/mapping.ts
var MARKDOWN_EXTENSION = ".md";
var UTF82 = new TextDecoder("utf-8", { fatal: true });
function isMarkdownPath(path) {
  return path.endsWith(MARKDOWN_EXTENSION) && path.length > MARKDOWN_EXTENSION.length && !path.endsWith(`/${MARKDOWN_EXTENSION}`);
}

// src/sync/security.ts
function runHooks(dir, args, env) {
  return new Promise((resolve) => {
    const child = spawn3("pre-commit", args, { cwd: dir, env: { ...env, PRE_COMMIT_COLOR: "never", GIT_TERMINAL_PROMPT: "0" }, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    const collect = (chunk) => {
      if (output.length < 2e6) output += chunk.toString("utf8");
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    const timer = setTimeout(() => child.kill("SIGKILL"), 12e4);
    child.on("error", () => {
      clearTimeout(timer);
      resolve({ code: -1, output: "" });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, output });
    });
  });
}
var LFS_POINTER_BYTES = 1024;
var SCRATCH_BATCH_BYTES = 16 * 1024 * 1024;
var SCRATCH_BATCH_FILES = 32;
var SCRATCH_TREE_BYTES = 4 * 1024 * 1024 * 1024;
var SecurityScratchBudgetError = class extends Error {
  code = "security-scratch-budget";
  constructor(bytes) {
    super(message("sync.security-scratch-budget", { bytes }));
    this.name = "SecurityScratchBudgetError";
  }
};
var SecurityScratchTreeError = class extends Error {
  code = "security-scratch-tree";
  constructor() {
    super(message("sync.security-scratch-tree"));
    this.name = "SecurityScratchTreeError";
  }
};
function batchBytes(entry) {
  return entry.oid.length + String(entry.size).length + 8 + entry.size;
}
function blobSize(entry) {
  if (entry.size === null || !Number.isSafeInteger(entry.size) || entry.size < 0) throw new SecurityScratchTreeError();
  return entry;
}
function checkScratchBudget(entries, budget) {
  let total = 0;
  for (const entry of entries) {
    if (entry.type === "blob") total += blobSize(entry).size;
  }
  if (total > budget) throw new SecurityScratchBudgetError(budget);
}
async function readInBatches(git, entries, use, alone) {
  let batch = [];
  let bytes = 0;
  const flush = async () => {
    if (batch.length === 0) return;
    const blobs = await readBlobs(git, batch.map((entry) => entry.oid), bytes);
    await use(batch, blobs);
    batch = [];
    bytes = 0;
  };
  for (const entry of entries) {
    const size = batchBytes(entry);
    if (size > SCRATCH_BATCH_BYTES) {
      await alone(entry);
      continue;
    }
    if (batch.length === SCRATCH_BATCH_FILES || bytes + size > SCRATCH_BATCH_BYTES) await flush();
    batch.push(entry);
    bytes += size;
  }
  await flush();
}
async function trackedHookConfig(git, tracked) {
  const config = readHookConfig((await git.readBlob(`${tracked}:${PRE_COMMIT_CONFIG}`))?.toString("utf8") ?? null);
  if (config.invalid !== void 0) throw new Error(message("sync.invalid-security-config"));
  return config;
}
async function onlyDocumentsChanged(scratch, dir, files, linkedSupport) {
  const changed = (await scratch.run(["diff", "--name-only", "--no-renames", "-z"])).stdout.toString("utf8").split("\0").filter((path) => path !== "");
  for (const path of changed) {
    if (linkedSupport.some((target) => path === target || path.startsWith(`${target}/`))) return false;
    if (isMarkdownPath(path)) continue;
    const read = await scratch.run(["cat-file", "blob", `:${path}`], { maxOutputBytes: LFS_POINTER_BYTES }).catch((error) => {
      if (error instanceof GitOutputLimitError) return null;
      throw error;
    });
    if (read === null) return false;
    const pointer = parseLfsPointer(read.stdout);
    const content = files.get(path);
    if (pointer === null || content === void 0) return false;
    const bytes = contentBytes(content);
    if (pointer.size !== bytes.length || pointer.oid !== createHash2("sha256").update(bytes).digest("hex")) return false;
    if (!(await readFile(join3(dir, path))).equals(bytes)) return false;
  }
  return true;
}
async function throughLink(dir, path) {
  const parts = path.split("/");
  for (let at = 1; at <= parts.length; at++) {
    const found = await lstat(join3(dir, ...parts.slice(0, at))).catch(() => null);
    if (found === null) return false;
    if (found.isSymbolicLink()) return true;
  }
  return false;
}
async function reproduceTree(git, tracked, entries, scratch, dir) {
  for (const entry of entries) checkRepoPath(entry.path);
  const files = entries.filter((entry) => entry.type === "blob" && ["100644", "100755"].includes(entry.mode));
  const links = entries.filter((entry) => entry.type === "blob" && entry.mode === "120000");
  const gitlinks = entries.filter((entry) => entry.type === "commit");
  const fileMode = (entry) => entry.mode === "100755" ? 493 : 420;
  await readInBatches(git, files, async (batch, blobs) => {
    for (const entry of batch) {
      await mkdir(dirname(join3(dir, entry.path)), { recursive: true });
      await writeFile(join3(dir, entry.path), blobs.get(entry.oid), { mode: fileMode(entry) });
    }
  }, async (entry) => {
    await mkdir(dirname(join3(dir, entry.path)), { recursive: true });
    await git.runToFile(["cat-file", "blob", entry.oid], join3(dir, entry.path), fileMode(entry));
  });
  for (const entry of gitlinks) await mkdir(join3(dir, entry.path), { recursive: true });
  await readInBatches(git, links, async (batch, targets) => {
    for (const entry of batch) {
      await mkdir(dirname(join3(dir, entry.path)), { recursive: true });
      await symlink(targets.get(entry.oid), join3(dir, entry.path));
    }
  }, async () => {
    throw new Error(message("sync.security-link-outside"));
  });
  const root = await realpath(dir);
  const linkedSupport = [];
  for (const entry of links) {
    const target = await realpath(join3(dir, entry.path));
    const inside = target.slice(root.length + 1).split(sep);
    if (!target.startsWith(root + sep) || isGitDirectoryName(inside[0])) throw new Error(message("sync.security-link-outside"));
    if (!isMarkdownPath(entry.path)) linkedSupport.push(inside.join("/"));
  }
  await mkdir(join3(dir, ".git", "info"), { recursive: true });
  await writeFile(join3(dir, ".git", "info", "attributes"), "* -text -filter -ident -working-tree-encoding\n");
  await scratch.run(["add", "--all", "--force"]);
  if (gitlinks.length > 0) {
    await scratch.run(["update-index", "-z", "--index-info"], { input: gitlinks.map((entry) => `160000 ${entry.oid}	${entry.path}\0`).join("") });
  }
  const tree = await scratch.text(["write-tree"]);
  if (tree !== await git.revParse(`${tracked}^{tree}`)) throw new SecurityScratchTreeError();
  return { tree, linkedSupport };
}
async function securityGate(git, tracked, options = {}) {
  const env = options.env ?? { PATH: process.env.PATH, HOME: process.env.HOME, LANG: "C.UTF-8" };
  const config = await trackedHookConfig(git, tracked);
  const hooks = securityHooks(config);
  if (hooks.length > 0 && (await runHooks(git.dir, ["--version"], env)).code !== 0) throw new Error(message("sync.needs-pre-commit"));
  const budget = options.scratchBytes ?? SCRATCH_TREE_BYTES;
  let dir;
  let scratch;
  let baseline;
  let linkedSupport = [];
  const close = async () => {
    if (dir !== void 0) await rm(dir, { recursive: true, force: true });
    dir = void 0;
  };
  const gate = {
    configured: hooks.length > 0,
    close,
    async check(files, batch = false) {
      if (hooks.length === 0) return [];
      try {
        if (dir === void 0) {
          const entries = await listTree(git, tracked);
          checkScratchBudget(entries, budget);
          dir = await mkdtemp(join3(tmpdir2(), "capture-security-"));
          scratch = new Git(dir);
          await scratch.run(["init", "--quiet", `--object-format=${await git.text(["rev-parse", "--show-object-format"])}`]);
          ({ tree: baseline, linkedSupport } = await reproduceTree(git, tracked, entries, scratch, dir));
        }
        await scratch.run(["read-tree", "--reset", "-u", baseline]);
        await scratch.run(["clean", "-fdx", "--quiet"]);
        const written = /* @__PURE__ */ new Set();
        for (const [path, content] of files) {
          checkRepoPath(path);
          if (batch && (path.startsWith(":") || /[*?\[]/.test(path))) return [{ hook: SECURITY_ALIAS, line: 1 }];
          if (path === PRE_COMMIT_CONFIG || path.startsWith("-")) return [{ hook: SECURITY_ALIAS, line: 1 }];
          if (await throughLink(dir, path)) return [{ hook: SECURITY_ALIAS, line: 1 }];
          await mkdir(dirname(join3(dir, path)), { recursive: true });
          await writeFile(join3(dir, path), contentBytes(content));
          if (batch) {
            const { dev, ino } = await lstat(join3(dir, path), { bigint: true });
            const identity = `${dev}:${ino}`;
            if (written.has(identity)) return [{ hook: SECURITY_ALIAS, line: 1 }];
            written.add(identity);
          }
        }
        if (!await onlyDocumentsChanged(scratch, dir, files, linkedSupport)) return [{ hook: SECURITY_ALIAS, line: 1 }];
        await scratch.run(["add", "--force", "--", ...files.keys()]);
        const findings = [];
        let ran = false;
        for (const stage of ["pre-commit", "pre-push"]) {
          const result = await runHooks(dir, ["run", SECURITY_ALIAS, "--hook-stage", stage, "--files", ...files.keys()], env);
          if (result.code !== 0 && result.output.trim() === `No hook with id \`security\` in stage \`${stage}\``) continue;
          ran = true;
          if (result.code !== 0) {
            if (batch) return [{ hook: SECURITY_ALIAS, line: 1 }];
            const failed2 = hooks.filter((id) => result.output.includes(`- hook id: ${id}
`));
            const escaped2 = [...files.keys()].map((path) => path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
            const located = new RegExp(`(?:${escaped2.join("|")}):(\\d+)(?::|\\b)`, "g");
            const matches = [...result.output.matchAll(located)];
            const lines = matches.map((match) => Number(match[1])).filter((line) => Number.isSafeInteger(line) && line > 0);
            for (const hook of failed2.length > 0 ? failed2 : [SECURITY_ALIAS]) findings.push({ hook, line: lines[0] ?? 1 });
          }
        }
        if (!ran) findings.push({ hook: SECURITY_ALIAS, line: 1 });
        for (const [path, content] of files) {
          const after = await readFile(join3(dir, path)).catch(() => null);
          if (after === null || !after.equals(contentBytes(content))) findings.push({ hook: SECURITY_ALIAS, line: 1 });
        }
        return findings;
      } catch (error) {
        if (error instanceof SecurityScratchBudgetError || error instanceof SecurityScratchTreeError) {
          await close().catch(() => {
          });
          throw error;
        }
        return [{ hook: SECURITY_ALIAS, line: 1 }];
      }
    }
  };
  if (!config.securityBatchable || !gate.configured) return gate;
  return { ...gate, passesBatch: async (files) => (await gate.check(files, true)).length === 0 };
}

// src/sync/staged.ts
var STAGE_FOLDER = "mdbisync-candidates";
var MANIFEST = "manifest.json";
var ANSWERS = "answers.json";
var VERSION = 1;
var BATCH_SETS = 128;
var BATCH_CONTENT_BYTES = 32 * 1024 * 1024;
var BATCH_PATH_BYTES = 24 * 1024;
function stageFolder(env = process.env) {
  const base = env["RUNNER_TEMP"];
  if (base === void 0 || base === "") throw new Error(message("sync.no-runner-temp"));
  return join4(base, STAGE_FOLDER);
}
var sha256 = (content) => createHash3("sha256").update(contentBytes(content)).digest("hex");
function candidateKey(files) {
  const pairs = [...files].map(([path, content]) => [path, sha256(content)]).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  return sha256(JSON.stringify(pairs));
}
function union(sets) {
  const files = /* @__PURE__ */ new Map();
  for (const set of sets) for (const [path, content] of set.files) files.set(path, content);
  return files;
}
async function checkStaged(git, folder, env) {
  const manifest = JSON.parse(await readFile2(join4(folder, MANIFEST), "utf8"));
  if (manifest.version !== VERSION) throw new Error(message("sync.staged-version"));
  const result = { sets: manifest.sets.length, rejected: 0, unanswered: 0 };
  const answers = { version: VERSION, tracked: manifest.tracked, answers: {} };
  if (manifest.sets.length > 0) {
    const gate = await securityGate(git, manifest.tracked, { env });
    const record = (key, findings) => {
      if (findings.length > 0) result.rejected += 1;
      answers.answers[key] = findings;
    };
    const checkOne = async ({ key, files }) => {
      record(key, await gate.check(files) ?? [{ hook: SECURITY_ALIAS, line: 1 }]);
    };
    const checkBatch = async (sets, files) => {
      if (sets.length === 1) {
        await checkOne(sets[0]);
      } else if (await gate.passesBatch(files)) {
        for (const { key } of sets) record(key, []);
      } else {
        const middle = Math.floor(sets.length / 2);
        const left = sets.slice(0, middle);
        const right = sets.slice(middle);
        await checkBatch(left, union(left));
        await checkBatch(right, union(right));
      }
    };
    const batches = [];
    let pendingSets = 0;
    let pendingBytes = 0;
    let pendingPathBytes = 0;
    const flush = async () => {
      for (const { sets, files } of batches) await checkBatch(sets, files);
      batches.length = 0;
      pendingSets = pendingBytes = pendingPathBytes = 0;
    };
    try {
      for (const set of manifest.sets) {
        const files = /* @__PURE__ */ new Map();
        let bytes = 0;
        let pathBytes = 0;
        for (const { path, sha256: hash } of set.files) {
          checkRepoPath(path);
          if (!/^[0-9a-f]{64}$/.test(hash)) throw new Error(message("sync.staged-hash"));
          const content = await readFile2(join4(folder, "files", hash));
          files.set(path, content);
          bytes += content.length;
          pathBytes += Buffer.byteLength(path) + 1;
        }
        if ([...files].some(([path, content]) => sha256(content) !== set.files.find((file) => file.path === path)?.sha256) || candidateKey(files) !== set.key) {
          result.unanswered += 1;
          continue;
        }
        const verified = { key: set.key, files };
        if (gate.passesBatch === void 0 || files.size === 0 || bytes > BATCH_CONTENT_BYTES || pathBytes > BATCH_PATH_BYTES) {
          await flush();
          await checkOne(verified);
          continue;
        }
        if (pendingSets === BATCH_SETS || pendingBytes + bytes > BATCH_CONTENT_BYTES || pendingPathBytes + pathBytes > BATCH_PATH_BYTES) await flush();
        let batch = batches.find(({ files: combined }) => [...files].every(([path, content]) => combined.get(path)?.equals(content) ?? true));
        if (batch === void 0) {
          batch = { sets: [], files: /* @__PURE__ */ new Map() };
          batches.push(batch);
        }
        batch.sets.push(verified);
        for (const [path, content] of files) batch.files.set(path, content);
        pendingSets++;
        pendingBytes += bytes;
        pendingPathBytes += pathBytes;
      }
      await flush();
    } finally {
      await gate.close?.();
    }
  }
  await writeFile2(join4(folder, ANSWERS), JSON.stringify(answers), { mode: 384 });
  return result;
}

// src/action/hooks.ts
var RUNNER_COMMAND_FILES = ["GITHUB_ENV", "GITHUB_PATH", "GITHUB_OUTPUT", "GITHUB_STATE", "GITHUB_STEP_SUMMARY"];
async function runHooksStep(env = process.env) {
  try {
    const git = new Git(env["GITHUB_WORKSPACE"] || process.cwd());
    const hookEnv = Object.fromEntries(Object.entries(env).filter((entry) => entry[1] !== void 0 && !RUNNER_COMMAND_FILES.includes(entry[0])));
    const result = await checkStaged(git, stageFolder(env), hookEnv);
    console.log(`Security hooks: staged sets checked ${result.sets}, with findings ${result.rejected}, without an answer ${result.unanswered}.`);
    return 0;
  } catch (error) {
    console.log(`::error::security hooks: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}
if (import.meta.main) {
  process.exitCode = await runHooksStep();
}
export {
  runHooksStep
};
