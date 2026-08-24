/**
 * WMD Markdown 编辑器（pagedown Typecho 系 fork）
 *
 * 本文件是维护源（未压缩）。仓库历史上是单行压缩版本，直接改压缩文件
 * 容易出错、diff 不可读；本版本由 esbuild 反格式化后作为源提交，
 * 其中维护重点函数（doCode / doLinkOrImage）已进一步语义化命名。
 * 修改后请运行 `bun run test tests/unit/pagedown-editor.test.ts`，
 * 该测试从本文件提取 doCode / doLinkOrImage 做行为断言。
 *
 * 与上游 pagedown 的有意差异：
 *  - doLinkOrImage：链接/图片以内联 Markdown 插入 [text](url) / ![desc](url)，
 *    上游为引用式（[text][id] + 文末 [id]: url 定义行）
 *  - doCode：多行代码段用 ``` 围栏（上游为 4 空格缩进），单行仍用单个反引号
 */
var Markdown = "object" == typeof exports && "function" == typeof require ? exports : {};
(function() {
  function A(e) {
    return e;
  }
  function t(e) {
    return false;
  }
  function q() {
  }
  function W() {
  }
  q.prototype = { chain: function(e, n) {
    var r = this[e];
    if (!r) throw new Error("unknown hook " + e);
    this[e] = r === A ? n : function(e2) {
      var t2 = Array.prototype.slice.call(arguments, 0);
      return t2[0] = r.apply(null, t2), n.apply(null, t2);
    };
  }, set: function(e, t2) {
    if (!this[e]) throw new Error("unknown hook " + e);
    this[e] = t2;
  }, addNoop: function(e) {
    this[e] = A;
  }, addFalse: function(e) {
    this[e] = t;
  } }, Markdown.HookCollection = q, W.prototype = { set: function(e, t2) {
    this["s_" + e] = t2;
  }, get: function(e) {
    return this["s_" + e];
  } }, Markdown.Converter = function(e) {
    var c, l, s, n, r = this.hooks = new q();
    r.addNoop("plainLinkText"), r.addNoop("preConversion"), r.addNoop("postNormalization"), r.addNoop("preBlockGamut"), r.addNoop("postBlockGamut"), r.addNoop("preSpanGamut"), r.addNoop("postSpanGamut"), r.addNoop("postConversion");
    var t2, a, o, i, d, u = A, f = A;
    (e = e || {}).nonAsciiLetters && (t2 = /[Q\u00aa\u00b5\u00ba\u00c0-\u00d6\u00d8-\u00f6\u00f8-\u02c1\u02c6-\u02d1\u02e0-\u02e4\u02ec\u02ee\u0370-\u0374\u0376-\u0377\u037a-\u037d\u0386\u0388-\u038a\u038c\u038e-\u03a1\u03a3-\u03f5\u03f7-\u0481\u048a-\u0523\u0531-\u0556\u0559\u0561-\u0587\u05d0-\u05ea\u05f0-\u05f2\u0621-\u064a\u0660-\u0669\u066e-\u066f\u0671-\u06d3\u06d5\u06e5-\u06e6\u06ee-\u06fc\u06ff\u0710\u0712-\u072f\u074d-\u07a5\u07b1\u07c0-\u07ea\u07f4-\u07f5\u07fa\u0904-\u0939\u093d\u0950\u0958-\u0961\u0966-\u096f\u0971-\u0972\u097b-\u097f\u0985-\u098c\u098f-\u0990\u0993-\u09a8\u09aa-\u09b0\u09b2\u09b6-\u09b9\u09bd\u09ce\u09dc-\u09dd\u09df-\u09e1\u09e6-\u09f1\u0a05-\u0a0a\u0a0f-\u0a10\u0a13-\u0a28\u0a2a-\u0a30\u0a32-\u0a33\u0a35-\u0a36\u0a38-\u0a39\u0a59-\u0a5c\u0a5e\u0a66-\u0a6f\u0a72-\u0a74\u0a85-\u0a8d\u0a8f-\u0a91\u0a93-\u0aa8\u0aaa-\u0ab0\u0ab2-\u0ab3\u0ab5-\u0ab9\u0abd\u0ad0\u0ae0-\u0ae1\u0ae6-\u0aef\u0b05-\u0b0c\u0b0f-\u0b10\u0b13-\u0b28\u0b2a-\u0b30\u0b32-\u0b33\u0b35-\u0b39\u0b3d\u0b5c-\u0b5d\u0b5f-\u0b61\u0b66-\u0b6f\u0b71\u0b83\u0b85-\u0b8a\u0b8e-\u0b90\u0b92-\u0b95\u0b99-\u0b9a\u0b9c\u0b9e-\u0b9f\u0ba3-\u0ba4\u0ba8-\u0baa\u0bae-\u0bb9\u0bd0\u0be6-\u0bef\u0c05-\u0c0c\u0c0e-\u0c10\u0c12-\u0c28\u0c2a-\u0c33\u0c35-\u0c39\u0c3d\u0c58-\u0c59\u0c60-\u0c61\u0c66-\u0c6f\u0c85-\u0c8c\u0c8e-\u0c90\u0c92-\u0ca8\u0caa-\u0cb3\u0cb5-\u0cb9\u0cbd\u0cde\u0ce0-\u0ce1\u0ce6-\u0cef\u0d05-\u0d0c\u0d0e-\u0d10\u0d12-\u0d28\u0d2a-\u0d39\u0d3d\u0d60-\u0d61\u0d66-\u0d6f\u0d7a-\u0d7f\u0d85-\u0d96\u0d9a-\u0db1\u0db3-\u0dbb\u0dbd\u0dc0-\u0dc6\u0e01-\u0e30\u0e32-\u0e33\u0e40-\u0e46\u0e50-\u0e59\u0e81-\u0e82\u0e84\u0e87-\u0e88\u0e8a\u0e8d\u0e94-\u0e97\u0e99-\u0e9f\u0ea1-\u0ea3\u0ea5\u0ea7\u0eaa-\u0eab\u0ead-\u0eb0\u0eb2-\u0eb3\u0ebd\u0ec0-\u0ec4\u0ec6\u0ed0-\u0ed9\u0edc-\u0edd\u0f00\u0f20-\u0f29\u0f40-\u0f47\u0f49-\u0f6c\u0f88-\u0f8b\u1000-\u102a\u103f-\u1049\u1050-\u1055\u105a-\u105d\u1061\u1065-\u1066\u106e-\u1070\u1075-\u1081\u108e\u1090-\u1099\u10a0-\u10c5\u10d0-\u10fa\u10fc\u1100-\u1159\u115f-\u11a2\u11a8-\u11f9\u1200-\u1248\u124a-\u124d\u1250-\u1256\u1258\u125a-\u125d\u1260-\u1288\u128a-\u128d\u1290-\u12b0\u12b2-\u12b5\u12b8-\u12be\u12c0\u12c2-\u12c5\u12c8-\u12d6\u12d8-\u1310\u1312-\u1315\u1318-\u135a\u1380-\u138f\u13a0-\u13f4\u1401-\u166c\u166f-\u1676\u1681-\u169a\u16a0-\u16ea\u1700-\u170c\u170e-\u1711\u1720-\u1731\u1740-\u1751\u1760-\u176c\u176e-\u1770\u1780-\u17b3\u17d7\u17dc\u17e0-\u17e9\u1810-\u1819\u1820-\u1877\u1880-\u18a8\u18aa\u1900-\u191c\u1946-\u196d\u1970-\u1974\u1980-\u19a9\u19c1-\u19c7\u19d0-\u19d9\u1a00-\u1a16\u1b05-\u1b33\u1b45-\u1b4b\u1b50-\u1b59\u1b83-\u1ba0\u1bae-\u1bb9\u1c00-\u1c23\u1c40-\u1c49\u1c4d-\u1c7d\u1d00-\u1dbf\u1e00-\u1f15\u1f18-\u1f1d\u1f20-\u1f45\u1f48-\u1f4d\u1f50-\u1f57\u1f59\u1f5b\u1f5d\u1f5f-\u1f7d\u1f80-\u1fb4\u1fb6-\u1fbc\u1fbe\u1fc2-\u1fc4\u1fc6-\u1fcc\u1fd0-\u1fd3\u1fd6-\u1fdb\u1fe0-\u1fec\u1ff2-\u1ff4\u1ff6-\u1ffc\u203f-\u2040\u2054\u2071\u207f\u2090-\u2094\u2102\u2107\u210a-\u2113\u2115\u2119-\u211d\u2124\u2126\u2128\u212a-\u212d\u212f-\u2139\u213c-\u213f\u2145-\u2149\u214e\u2183-\u2184\u2c00-\u2c2e\u2c30-\u2c5e\u2c60-\u2c6f\u2c71-\u2c7d\u2c80-\u2ce4\u2d00-\u2d25\u2d30-\u2d65\u2d6f\u2d80-\u2d96\u2da0-\u2da6\u2da8-\u2dae\u2db0-\u2db6\u2db8-\u2dbe\u2dc0-\u2dc6\u2dc8-\u2dce\u2dd0-\u2dd6\u2dd8-\u2dde\u2e2f\u3005-\u3006\u3031-\u3035\u303b-\u303c\u3041-\u3096\u309d-\u309f\u30a1-\u30fa\u30fc-\u30ff\u3105-\u312d\u3131-\u318e\u31a0-\u31b7\u31f0-\u31ff\u3400-\u4db5\u4e00-\u9fc3\ua000-\ua48c\ua500-\ua60c\ua610-\ua62b\ua640-\ua65f\ua662-\ua66e\ua67f-\ua697\ua717-\ua71f\ua722-\ua788\ua78b-\ua78c\ua7fb-\ua801\ua803-\ua805\ua807-\ua80a\ua80c-\ua822\ua840-\ua873\ua882-\ua8b3\ua8d0-\ua8d9\ua900-\ua925\ua930-\ua946\uaa00-\uaa28\uaa40-\uaa42\uaa44-\uaa4b\uaa50-\uaa59\uac00-\ud7a3\uf900-\ufa2d\ufa30-\ufa6a\ufa70-\ufad9\ufb00-\ufb06\ufb13-\ufb17\ufb1d\ufb1f-\ufb28\ufb2a-\ufb36\ufb38-\ufb3c\ufb3e\ufb40-\ufb41\ufb43-\ufb44\ufb46-\ufbb1\ufbd3-\ufd3d\ufd50-\ufd8f\ufd92-\ufdc7\ufdf0-\ufdfb\ufe33-\ufe34\ufe4d-\ufe4f\ufe70-\ufe74\ufe76-\ufefc\uff10-\uff19\uff21-\uff3a\uff3f\uff41-\uff5a\uff66-\uffbe\uffc2-\uffc7\uffca-\uffcf\uffd2-\uffd7\uffda-\uffdc]/g, a = "Q".charCodeAt(0), o = "A".charCodeAt(0), i = "Z".charCodeAt(0), d = "a".charCodeAt(0) - i - 1, u = function(e2) {
      return e2.replace(t2, function(e3) {
        for (var t3, n2 = e3.charCodeAt(0), r2 = ""; 0 < n2; ) a <= (t3 = n2 % 51 + o) && t3++, i < t3 && (t3 += d), r2 = String.fromCharCode(t3) + r2, n2 = n2 / 51 | 0;
        return "Q" + r2 + "Q";
      });
    }, f = function(e2) {
      return e2.replace(/Q([A-PR-Za-z]{1,3})Q/g, function(e3, t3) {
        for (var n2, r2 = 0, u2 = 0; u2 < t3.length; u2++) n2 = t3.charCodeAt(u2), i < n2 && (n2 -= d), a < n2 && n2--, r2 = 51 * r2 + (n2 -= o);
        return String.fromCharCode(r2);
      });
    });
    var p = e.asteriskIntraWordEmphasis ? function(e2) {
      return -1 === e2.indexOf("*") && -1 === e2.indexOf("_") ? e2 : (e2 = (e2 = (e2 = u(e2)).replace(/(?=[^\r][*_]|[*_])(^|(?=\W__|(?!\*)[\W_]\*\*|\w\*\*\w)[^\r])(\*\*|__)(?!\2)(?=\S)((?:|[^\r]*?(?!\2)[^\r])(?=\S_|\w|\S\*\*(?:[\W_]|$)).)(?=__(?:\W|$)|\*\*(?:[^*]|$))\2/g, "$1<strong>$3</strong>")).replace(/(?=[^\r][*_]|[*_])(^|(?=\W_|(?!\*)(?:[\W_]\*|\D\*(?=\w)\D))[^\r])(\*|_)(?!\2\2\2)(?=\S)((?:(?!\2)[^\r])*?(?=[^\s_]_|(?=\w)\D\*\D|[^\s*]\*(?:[\W_]|$)).)(?=_(?:\W|$)|\*(?:[^*]|$))\2/g, "$1<em>$3</em>"), f(e2));
    } : function(e2) {
      return -1 === e2.indexOf("*") && -1 === e2.indexOf("_") ? e2 : (e2 = (e2 = (e2 = u(e2)).replace(/(^|[\W_])(?:(?!\1)|(?=^))(\*|_)\2(?=\S)([^\r]*?\S)\2\2(?!\2)(?=[\W_]|$)/g, "$1<strong>$3</strong>")).replace(/(^|[\W_])(?:(?!\1)|(?=^))(\*|_)(?=\S)((?:(?!\2)[^\r])*?\S)\2(?!\2)(?=[\W_]|$)/g, "$1<em>$3</em>"), f(e2));
    };
    function g(e2) {
      return e2 = (e2 = (e2 = (e2 = (e2 = e2.replace(/^(<(p|div|h[1-6]|blockquote|pre|table|dl|ol|ul|script|noscript|form|fieldset|iframe|math|ins|del)\b[^\r]*?\n<\/\2>[ \t]*(?=\n+))/gm, m)).replace(/^(<(p|div|h[1-6]|blockquote|pre|table|dl|ol|ul|script|noscript|form|fieldset|iframe|math)\b[^\r]*?.*<\/\2>[ \t]*(?=\n+)\n)/gm, m)).replace(/\n[ ]{0,3}((<(hr)\b([^<>])*?\/?>)[ \t]*(?=\n{2,}))/g, m)).replace(/\n\n[ ]{0,3}(<!(--(?:|(?:[^>-]|-[^>])(?:[^-]|-[^-])*)--)>[ \t]*(?=\n{2,}))/g, m)).replace(/(?:\n\n)([ ]{0,3}(?:<([?%])[^\r]*?\2>)[ \t]*(?=\n{2,}))/g, m);
    }
    function h(e2) {
      return e2 = e2.replace(/(^\n+|\n+$)/g, ""), "\n\n~K" + (s.push(e2) - 1) + "K\n\n";
    }
    function m(e2, t3) {
      return h(t3);
    }
    this.makeHtml = function(e2) {
      if (c) throw new Error("Recursive call to converter.makeHtml");
      return c = new W(), l = new W(), s = [], n = 0, e2 = (e2 = I(e2 = "\n\n" + (e2 = (e2 = (e2 = (e2 = (e2 = r.preConversion(e2)).replace(/~/g, "~T")).replace(/\$/g, "~D")).replace(/\r\n/g, "\n")).replace(/\r/g, "\n")) + "\n\n")).replace(/^[ \t]+$/gm, ""), e2 = g(e2 = r.postNormalization(e2)), e2 = v(e2 = e2.replace(/^[ ]{0,3}\[([^\[\]]+)\]:[ \t]*\n?[ \t]*<?(\S+?)>?(?=\s|$)[ \t]*\n?[ \t]*((\n*)["(](.+?)[")][ \t]*)?(?:\n+)/gm, function(e3, t3, n2, r2, u2, a2) {
        return t3 = t3.toLowerCase(), c.set(t3, $(n2)), u2 ? r2 : (a2 && l.set(t3, a2.replace(/"/g, "&quot;")), "");
      })), e2 = (e2 = (e2 = e2.replace(/~E(\d+)E/g, function(e3, t3) {
        t3 = parseInt(t3);
        return String.fromCharCode(t3);
      })).replace(/~D/g, "$$")).replace(/~T/g, "~"), e2 = r.postConversion(e2), s = l = c = null, e2;
    };
    var b = function(e2) {
      return v(e2);
    };
    function v(e2, t3) {
      e2 = r.preBlockGamut(e2, b);
      var n2 = "<hr />\n";
      return e2 = C(e2 = (e2 = (e2 = (e2 = e2.replace(/^(.+)[ \t]*\n=+[ \t]*\n+/gm, function(e3, t4) {
        return "<h1>" + w(t4) + "</h1>\n\n";
      }).replace(/^(.+)[ \t]*\n-+[ \t]*\n+/gm, function(e3, t4) {
        return "<h2>" + w(t4) + "</h2>\n\n";
      }).replace(/^(\#{1,6})[ \t]*(.+?)[ \t]*\#*\n+/gm, function(e3, t4, n3) {
        t4 = t4.length;
        return "<h" + t4 + ">" + w(n3) + "</h" + t4 + ">\n\n";
      })).replace(/^[ ]{0,2}([ ]?\*[ ]?){3,}[ \t]*$/gm, n2)).replace(/^[ ]{0,2}([ ]?-[ ]?){3,}[ \t]*$/gm, n2)).replace(/^[ ]{0,2}([ ]?_[ ]?){3,}[ \t]*$/gm, n2)), n2 = e2, e2 = n2 = (n2 = (n2 += "~0").replace(/(?:\n\n|^\n?)((?:(?:[ ]{4}|\t).*\n+)+)(\n*[ ]{0,3}[^ \t\n]|(?=~0))/g, function(e3, t4, n3) {
        return "\n\n" + (t4 = "<pre><code>" + (t4 = (t4 = (t4 = I(t4 = E(H(t4)))).replace(/^\n+/g, "")).replace(/\n+$/g, "")) + "\n</code></pre>") + "\n\n" + n3;
      })).replace(/~0/, ""), e2 = e2.replace(/((^[ \t]*>[ \t]?.+\n(.+\n)*\n*)+)/gm, function(e3, t4) {
        return h("<blockquote>\n" + (t4 = (t4 = (t4 = v(t4 = (t4 = (t4 = t4.replace(/^[ \t]*>[ \t]?/gm, "~0")).replace(/~0/g, "")).replace(/^[ \t]+$/gm, ""))).replace(/(^|\n)/g, "$1  ")).replace(/(\s*<pre>[^\r]+?<\/pre>)/gm, function(e4, t5) {
          return t5.replace(/^  /gm, "~0").replace(/~0/g, "");
        })) + "\n</blockquote>");
      }), e2 = (function(e3, t4) {
        for (var n3 = (e3 = (e3 = e3.replace(/^\n+/g, "")).replace(/\n+$/g, "")).split(/\n{2,}/g), r2 = [], u2 = /~K(\d+)K/, a2 = n3.length, o2 = 0; o2 < a2; o2++) {
          var i2 = n3[o2];
          u2.test(i2) ? r2.push(i2) : /\S/.test(i2) && (i2 = (i2 = w(i2)).replace(/^([ \t]*)/g, "<p>"), i2 += "</p>", r2.push(i2));
        }
        if (!t4) {
          a2 = r2.length;
          for (o2 = 0; o2 < a2; o2++) for (var c2 = true; c2; ) c2 = false, r2[o2] = r2[o2].replace(/~K(\d+)K/g, function(e4, t5) {
            return c2 = true, s[t5];
          });
        }
        return r2.join("\n\n");
      })(e2 = g(e2 = r.postBlockGamut(e2, b)), t3);
    }
    function w(e2) {
      var t3;
      return e2 = r.preSpanGamut(e2), e2 = e2.replace(/(^|[^\\`])(`+)(?!`)([^\r]*?[^`])\2(?!`)/gm, function(e3, t4, n2, r2, u2) {
        return t4 + "<code>" + (r2 = (r2 = E(r2 = (r2 = r2.replace(/^([ \t]*)/g, "")).replace(/[ \t]*$/g, ""))).replace(/:\/\//g, "~P")) + "</code>";
      }), e2 = e2.replace(/(<[a-z\/!$]("[^"]*"|'[^']*'|[^'">])*>|<!(--(?:|(?:[^>-]|-[^>])(?:[^-]|-[^-])*)--)>)/gi, function(e3) {
        return B(e3.replace(/(.)<\/?code>(?=.)/g, "$1`"), "!" == e3.charAt(1) ? "\\`*_/" : "\\`*_");
      }), e2 = e2.replace(/\\(\\)/g, N).replace(/\\([`*_{}\[\]()>#+-.!])/g, N), e2 = -1 === (t3 = e2).indexOf("![") ? t3 : t3 = (t3 = t3.replace(/(!\[(.*?)\][ ]?(?:\n[ ]*)?\[(.*?)\])()()()()/g, T)).replace(/(!\[(.*?)\]\s?\([ \t]*()<?(\S+?)>?[ \t]*((['"])(.*?)\6[ \t]*)?\))/g, T), e2 = $(e2 = (e2 = (function(e3) {
        e3 = e3.replace(L, _);
        return e3 = e3.replace(/<((https?|ftp):[^'">\s]+)>/gi, function(e4, t4) {
          return '<a href="' + R(t4) + '">' + r.plainLinkText(t4) + "</a>";
        });
      })(e2 = -1 === (t3 = e2).indexOf("[") ? t3 : t3 = (t3 = (t3 = t3.replace(/(\[((?:\[[^\]]*\]|[^\[\]])*)\][ ]?(?:\n[ ]*)?\[(.*?)\])()()()()/g, k)).replace(/(\[((?:\[[^\]]*\]|[^\[\]])*)\]\([ \t]*()<?((?:\([^)]*\)|[^()\s])*?)>?[ \t]*((['"])(.*?)\6[ \t]*)?\))/g, k)).replace(/(\[([^\[\]]+)\])()()()()()/g, k))).replace(/~P/g, "://")), e2 = (e2 = p(e2)).replace(/  +\n/g, " <br>\n"), e2 = r.postSpanGamut(e2);
    }
    function k(e2, t3, n2, r2, u2, a2, o2, i2) {
      null == i2 && (i2 = "");
      n2 = n2.replace(/:\/\//g, "~P"), r2 = r2.toLowerCase();
      if ("" == u2) if (u2 = "#" + (r2 = "" == r2 ? n2.toLowerCase().replace(/ ?\n/g, " ") : r2), null != c.get(r2)) u2 = c.get(r2), null != l.get(r2) && (i2 = l.get(r2));
      else {
        if (!(-1 < t3.search(/\(\s*\)$/m))) return t3;
        u2 = "";
      }
      u2 = '<a href="' + (u2 = R(u2)) + '"';
      return "" != i2 && (u2 += ' title="' + (i2 = B(i2 = x(i2), "*_")) + '"'), u2 += ">" + n2 + "</a>";
    }
    function x(e2) {
      return e2.replace(/>/g, "&gt;").replace(/</g, "&lt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
    }
    function T(e2, t3, n2, r2, u2, a2, o2, i2) {
      r2 = r2.toLowerCase(), i2 = i2 || "";
      if ("" == u2) {
        if (u2 = "#" + (r2 = "" == r2 ? n2.toLowerCase().replace(/ ?\n/g, " ") : r2), null == c.get(r2)) return t3;
        u2 = c.get(r2), null != l.get(r2) && (i2 = l.get(r2));
      }
      n2 = B(x(n2), "*_[]()"), n2 = '<img src="' + (u2 = B(u2, "*_")) + '" alt="' + n2 + '"';
      return n2 += ' title="' + (i2 = B(i2 = x(i2), "*_")) + '"', n2 += " />";
    }
    function C(e2, a2) {
      e2 += "~0";
      var t3 = /^(([ ]{0,3}([*+-]|\d+[.])[ \t]+)[^\r]+?(~0|\n{2,}(?=\S)(?![ \t]*(?:[*+-]|\d+[.])[ \t]+)))/gm;
      return e2 = (e2 = n ? e2.replace(t3, function(e3, t4, n2) {
        var r2, u2 = t4, t4 = -1 < n2.search(/[*+-]/g) ? "ul" : "ol";
        "ol" == t4 && (r2 = parseInt(n2, 10));
        n2 = y(u2, t4, a2), u2 = "<" + t4;
        return r2 && 1 !== r2 && (u2 += ' start="' + r2 + '"'), n2 = u2 + ">" + (n2 = n2.replace(/\s+$/, "")) + "</" + t4 + ">\n";
      }) : e2.replace(t3 = /(\n\n|^\n?)(([ ]{0,3}([*+-]|\d+[.])[ \t]+)[^\r]+?(~0|\n{2,}(?=\S)(?![ \t]*(?:[*+-]|\d+[.])[ \t]+)))/g, function(e3, t4, n2, r2) {
        var u2, a3 = t4, o2 = n2, t4 = -1 < r2.search(/[*+-]/g) ? "ul" : "ol", n2 = "<" + t4;
        return (u2 = "ol" == t4 ? parseInt(r2, 10) : u2) && 1 !== u2 && (n2 += ' start="' + u2 + '"'), a3 + n2 + ">\n" + y(o2, t4) + "</" + t4 + ">\n";
      })).replace(/~0/, "");
    }
    var S = { ol: "\\d+[.]", ul: "[*+-]" };
    function y(e2, t3, u2) {
      n++, e2 = e2.replace(/\n{2,}$/, "\n"), e2 += "~0";
      var t3 = S[t3], t3 = new RegExp("(^[ \\t]*)(" + t3 + ")[ \\t]+([^\\r]+?(\\n+))(?=(~0|\\1(" + t3 + ")[ \\t]+))", "gm"), a2 = false;
      return e2 = (e2 = e2.replace(t3, function(e3, t4, n2, r2) {
        t4 = /\n\n$/.test(r2);
        return t4 || -1 < r2.search(/\n{2,}/) || a2 ? r2 = v(H(r2), true) : (r2 = (r2 = C(H(r2), true)).replace(/\n$/, ""), u2 || (r2 = w(r2))), a2 = t4, "<li>" + r2 + "</li>\n";
      })).replace(/~0/g, ""), n--, e2;
    }
    function E(e2) {
      return e2 = B(e2 = (e2 = (e2 = e2.replace(/&/g, "&amp;")).replace(/</g, "&lt;")).replace(/>/g, "&gt;"), "*_{}[]\\", false);
    }
    function $(e2) {
      return e2 = (e2 = e2.replace(/&(?!#?[xX]?(?:[0-9a-fA-F]+|\w+);)/g, "&amp;")).replace(/<(?![a-z\/?!]|~D)/gi, "&lt;");
    }
    var e = "[-A-Z0-9+&@#/%=~_|[\\])]", L = new RegExp('(="|<)?\\b(https?|ftp)(://[-A-Z0-9+&@#/%?=~_|[\\]()!:,.;]*' + e + ")(?=$|\\W)", "gi"), F = new RegExp(e, "i");
    function _(e2, t3, n2, r2) {
      if (t3) return e2;
      if (")" !== r2.charAt(r2.length - 1)) return "<" + n2 + r2 + ">";
      for (var u2 = r2.match(/[()]/g), a2 = 0, o2 = 0; o2 < u2.length; o2++) "(" === u2[o2] ? a2 <= 0 ? a2 = 1 : a2++ : a2--;
      var i2, c2 = "";
      return a2 < 0 && (i2 = new RegExp("\\){1," + -a2 + "}$"), r2 = r2.replace(i2, function(e3) {
        return c2 = e3, "";
      })), c2 && (i2 = r2.charAt(r2.length - 1), F.test(i2) || (c2 = i2 + c2, r2 = r2.substr(0, r2.length - 1))), "<" + n2 + r2 + ">" + c2;
    }
    function H(e2) {
      return e2 = (e2 = e2.replace(/^(\t|[ ]{1,4})/gm, "~0")).replace(/~0/g, "");
    }
    function I(e2) {
      if (!/\t/.test(e2)) return e2;
      var n2, r2 = ["    ", "   ", "  ", " "], u2 = 0;
      return e2.replace(/[\n\t]/g, function(e3, t3) {
        return "\n" === e3 ? (u2 = t3 + 1, e3) : (n2 = (t3 - u2) % 4, u2 = t3 + 1, r2[n2]);
      });
    }
    function R(e2) {
      return e2 = B(e2 = x(e2), "*_:()[]");
    }
    function B(e2, t3, n2) {
      t3 = "([" + t3.replace(/([\[\]\\])/g, "\\$1") + "])";
      n2 && (t3 = "\\\\" + t3);
      t3 = new RegExp(t3, "g");
      return e2 = e2.replace(t3, N);
    }
    function N(e2, t3) {
      return "~E" + t3.charCodeAt(0) + "E";
    }
  };
})(), (function() {
  var b = {}, v = {}, w = {}, k = window.document, d = window.RegExp, x = window.navigator, f = 72, T = { isIE: /msie/.test(x.userAgent.toLowerCase()), isIE_5or6: /msie 6/.test(x.userAgent.toLowerCase()) || /msie 5/.test(x.userAgent.toLowerCase()), isOpera: /opera/.test(x.userAgent.toLowerCase()) }, n = { bold: "Strong <strong> Ctrl+B", boldexample: "strong text", italic: "Emphasis <em> Ctrl+I", italicexample: "emphasized text", link: "Hyperlink <a> Ctrl+L", linkdescription: "enter link description here", linkdialog: '<p><b>Insert Hyperlink</b></p><p>http://example.com/ "optional title"</p>', linkname: null, quote: "Blockquote <blockquote> Ctrl+Q", quoteexample: "Blockquote", code: "Code Sample <pre><code> Ctrl+K", codeexample: "enter code here", image: "Image <img> Ctrl+G", imagedescription: "enter image description here", imagedialog: `<p><b>Insert Image</b></p><p>http://example.com/images/diagram.jpg "optional title"<br>Need <a href='http://www.google.com/search?q=free+image+hosting' target='_blank'>free image hosting?</a></p>`, imagename: null, olist: "Numbered List <ol> Ctrl+O", ulist: "Bulleted List <ul> Ctrl+U", litem: "List item", heading: "Heading <h1>/<h2> Ctrl+H", headingexample: "Heading", more: "More contents <!--more--> Ctrl+M", fullscreen: "FullScreen Ctrl+J", exitFullscreen: "Exit FullScreen Ctrl+E", fullscreenUnsupport: "Sorry, the browser dont support fullscreen api", hr: "Horizontal Rule <hr> Ctrl+R", undo: "Undo - Ctrl+Z", redo: "Redo - Ctrl+Y", redomac: "Redo - Ctrl+Shift+Z", ok: "OK", cancel: "Cancel", help: "Markdown Editing Help" };
  function t() {
  }
  function p(e2) {
    this.buttonBar = k.getElementById("wmd-button-bar" + e2), this.preview = k.getElementById("wmd-preview" + e2), this.input = k.getElementById("text");
  }
  function g(t2, n2) {
    var r, u2, a, o = this, i = [], c = 0, l = "none", s = function(e2, t3) {
      l != e2 && (l = e2, t3 || f2()), T.isIE && "moving" == l ? a = null : u2 = setTimeout(d2, 1);
    }, d2 = function(e2) {
      a = new C(n2, e2), u2 = void 0;
    };
    this.setCommandMode = function() {
      l = "command", f2(), u2 = setTimeout(d2, 0);
    }, this.canUndo = function() {
      return 1 < c;
    }, this.canRedo = function() {
      return !!i[c + 1];
    }, this.undo = function() {
      o.canUndo() && (r ? (r.restore(), r = null) : (i[c] = new C(n2), i[--c].restore(), t2 && t2())), l = "none", n2.input.focus(), d2();
    }, this.redo = function() {
      o.canRedo() && (i[++c].restore(), t2 && t2()), l = "none", n2.input.focus(), d2();
    };
    var f2 = function() {
      var e2 = a || new C(n2);
      if (!e2) return false;
      "moving" != l ? (r && (i[c - 1].text != r.text && (i[c++] = r), r = null), i[c++] = e2, i[c + 1] = null, t2 && t2()) : r = r || e2;
    }, p2 = function(e2) {
      var t3 = false;
      if ((e2.ctrlKey || e2.metaKey) && !e2.altKey) {
        var n3 = e2.charCode || e2.keyCode;
        switch (String.fromCharCode(n3).toLowerCase()) {
          case "y":
            o.redo(), t3 = true;
            break;
          case "z":
            e2.shiftKey ? o.redo() : o.undo(), t3 = true;
        }
      }
      t3 && (e2.preventDefault && e2.preventDefault(), window.event && (window.event.returnValue = false));
    }, g2 = function(e2) {
      e2.ctrlKey || e2.metaKey || (33 <= (e2 = e2.keyCode) && e2 <= 40 || 63232 <= e2 && e2 <= 63235 ? s("moving") : 8 == e2 || 46 == e2 || 127 == e2 ? s("deleting") : 13 == e2 ? s("newlines") : 27 == e2 ? s("escape") : (e2 < 16 || 20 < e2) && 91 != e2 && s("typing"));
    };
    !(function() {
      b.addEvent(n2.input, "keypress", function(e3) {
        !e3.ctrlKey && !e3.metaKey || e3.altKey || 89 != e3.keyCode && 90 != e3.keyCode || e3.preventDefault();
      });
      function e2() {
        (T.isIE || a && a.text != n2.input.value) && null == u2 && (l = "paste", f2(), d2());
      }
      b.addEvent(n2.input, "keydown", p2), b.addEvent(n2.input, "keydown", g2), b.addEvent(n2.input, "mousedown", function() {
        s("moving");
      }), n2.input.onpaste = e2, n2.input.ondrop = e2;
    })(), d2(true), f2();
  }
  function C(a, e2) {
    var o = this, i = a.input;
    this.init = function() {
      b.isVisible(i) && (!e2 && k.activeElement && k.activeElement !== i || (this.setInputAreaSelectionStartEnd(), this.scrollTop = i.scrollTop, (!this.text && i.selectionStart || 0 === i.selectionStart) && (this.text = i.value)));
    }, this.setInputAreaSelection = function() {
      var e3;
      b.isVisible(i) && (void 0 === i.selectionStart || T.isOpera ? k.selection && (k.activeElement && k.activeElement !== i || (i.focus(), (e3 = i.createTextRange()).moveStart("character", -i.value.length), e3.moveEnd("character", -i.value.length), e3.moveEnd("character", o.end), e3.moveStart("character", o.start), e3.select())) : (i.focus(), i.selectionStart = o.start, i.selectionEnd = o.end, i.scrollTop = o.scrollTop));
    }, this.setInputAreaSelectionStartEnd = function() {
      if (a.ieCachedRange || !i.selectionStart && 0 !== i.selectionStart) {
        if (k.selection) {
          o.text = b.fixEolChars(i.value);
          var e3 = a.ieCachedRange || k.selection.createRange(), t2 = b.fixEolChars(e3.text), n2 = "\x07" + t2 + "\x07";
          e3.text = n2;
          var r = b.fixEolChars(i.value);
          e3.moveStart("character", -n2.length), e3.text = t2, o.start = r.indexOf("\x07"), o.end = r.lastIndexOf("\x07") - "\x07".length;
          var u2 = o.text.length - b.fixEolChars(i.value).length;
          if (u2) {
            for (e3.moveStart("character", -t2.length); u2--; ) t2 += "\n", o.end += 1;
            e3.text = t2;
          }
          a.ieCachedRange && (o.scrollTop = a.ieCachedScrollTop), a.ieCachedRange = null, this.setInputAreaSelection();
        }
      } else o.start = i.selectionStart, o.end = i.selectionEnd;
    }, this.restore = function() {
      null != o.text && o.text != i.value && (i.value = o.text), this.setInputAreaSelection(), i.scrollTop = o.scrollTop;
    }, this.getChunks = function() {
      var e3 = new t();
      return e3.before = b.fixEolChars(o.text.substring(0, o.start)), e3.startTag = "", e3.selection = b.fixEolChars(o.text.substring(o.start, o.end)), e3.endTag = "", e3.after = b.fixEolChars(o.text.substring(o.end)), e3.scrollTop = o.scrollTop, e3;
    }, this.setChunks = function(e3) {
      e3.before = e3.before + e3.startTag, e3.after = e3.endTag + e3.after, this.start = e3.before.length, this.end = e3.before.length + e3.selection.length, this.text = e3.before + e3.selection + e3.after, this.scrollTop = e3.scrollTop;
    }, this.init();
  }
  function h(r, u2, a) {
    function o() {
      var e3 = 0;
      return window.innerHeight ? e3 = window.pageYOffset : k.documentElement && k.documentElement.scrollTop ? e3 = k.documentElement.scrollTop : k.body && (e3 = k.body.scrollTop), e3;
    }
    function t2() {
      var e3, t3, n3;
      u2.preview && ((t3 = u2.input.value) && t3 == c || (c = t3, e3 = (/* @__PURE__ */ new Date()).getTime(), t3 = r.makeHtml(t3), n3 = (/* @__PURE__ */ new Date()).getTime(), i = n3 - e3, m2(t3)));
    }
    function n2() {
      e2 && (clearTimeout(e2), e2 = void 0), e2 = setTimeout(t2, 3e3 < i ? 3e3 : i);
    }
    var e2, i, c, l = function(e3) {
      return e3.scrollHeight <= e3.clientHeight ? 1 : e3.scrollTop / (e3.scrollHeight - e3.clientHeight);
    };
    this.refresh = function(e3) {
      e3 ? (c = "", t2()) : n2();
    }, this.processingTime = function() {
      return i;
    };
    var s, d2, f2, p2 = true, g2 = function(e3) {
      var t3 = u2.preview, n3 = t3.parentNode, r2 = t3.nextSibling;
      n3.removeChild(t3), t3.innerHTML = e3, r2 ? n3.insertBefore(t3, r2) : n3.appendChild(t3);
    }, h2 = function(e3) {
      u2.preview.innerHTML = e3;
    }, m2 = function(e3) {
      var t3, n3 = v.getTop(u2.input) - o();
      u2.preview && ((function(t4) {
        if (s) return s(t4);
        try {
          h2(t4), s = h2;
        } catch (e4) {
          (s = g2)(t4);
        }
      })(e3), a()), u2.preview && (u2.preview.scrollTop = (u2.preview.scrollHeight - u2.preview.clientHeight) * l(u2.preview)), p2 ? p2 = false : (t3 = v.getTop(u2.input) - o(), T.isIE ? setTimeout(function() {
        window.scrollBy(0, t3 - n3);
      }, 0) : window.scrollBy(0, t3 - n3));
    };
    d2 = u2.input, f2 = n2, b.addEvent(d2, "input", f2), d2.onpaste = f2, d2.ondrop = f2, b.addEvent(d2, "keypress", f2), b.addEvent(d2, "keydown", f2), t2(), u2.preview && (u2.preview.scrollTop = 0);
  }
  function m(c, u2, r, a, o, n2, l, s, d2) {
    var i = u2.input, f2 = {};
    !(function() {
      var e3 = u2.buttonBar, o2 = document.createElement("ul");
      o2.id = "wmd-button-row" + c, o2.className = "wmd-button-row", o2 = e3.appendChild(o2);
      var i2 = 0, t2 = function(e4, t3, n4, r2) {
        var u3 = document.createElement("li");
        u3.className = "wmd-button", u3.style.left = i2 + "px", i2 += 25;
        var a2 = document.createElement("span");
        return u3.id = e4 + c, u3.appendChild(a2), u3.title = t3, u3.XShift = n4, r2 && (u3.textOp = r2), g2(u3, true), o2.appendChild(u3), u3;
      }, n3 = function(e4) {
        var t3 = document.createElement("li");
        t3.className = "wmd-spacer wmd-spacer" + e4, t3.id = "wmd-spacer" + e4 + c, o2.appendChild(t3), i2 += 25;
      };
      f2.bold = t2("wmd-bold-button", d2("bold"), "0px", h2("doBold")), f2.italic = t2("wmd-italic-button", d2("italic"), "-20px", h2("doItalic")), n3(1), f2.link = t2("wmd-link-button", d2("link"), "-40px", h2(function(e4, t3) {
        return this.doLinkOrImage(e4, t3, false);
      })), f2.quote = t2("wmd-quote-button", d2("quote"), "-60px", h2("doBlockquote")), f2.code = t2("wmd-code-button", d2("code"), "-80px", h2("doCode")), f2.image = t2("wmd-image-button", d2("image"), "-100px", h2(function(e4, t3) {
        return this.doLinkOrImage(e4, t3, true);
      })), n3(2), f2.olist = t2("wmd-olist-button", d2("olist"), "-120px", h2(function(e4, t3) {
        this.doList(e4, t3, true);
      })), f2.ulist = t2("wmd-ulist-button", d2("ulist"), "-140px", h2(function(e4, t3) {
        this.doList(e4, t3, false);
      })), f2.heading = t2("wmd-heading-button", d2("heading"), "-160px", h2("doHeading")), f2.hr = t2("wmd-hr-button", d2("hr"), "-180px", h2("doHorizontalRule")), f2.more = t2("wmd-more-button", d2("more"), "-280px", h2("doMore")), n3(3), f2.undo = t2("wmd-undo-button", d2("undo"), "-200px", null), f2.undo.execute = function(e4) {
        e4 && e4.undo();
      };
      e3 = /win/.test(x.platform.toLowerCase()) ? d2("redo") : d2("redomac");
      f2.redo = t2("wmd-redo-button", e3, "-220px", null), f2.redo.execute = function(e4) {
        e4 && e4.redo();
      }, n3(4), f2.fullscreen = t2("wmd-fullscreen-button", d2("fullscreen"), "-240px", null), f2.fullscreen.execute = function() {
        l.doFullScreen(f2, true);
      }, f2.exitFullscreen = t2("wmd-exit-fullscreen-button", d2("exitFullscreen"), "-260px", null), f2.exitFullscreen.style.display = "none", f2.exitFullscreen.execute = function() {
        l.doFullScreen(f2, false);
      }, r.makeButton(f2, t2, h2, w), s && (n3 = document.createElement("li"), t2 = document.createElement("span"), n3.appendChild(t2), n3.className = "wmd-button wmd-help-button", n3.id = "wmd-help-button" + c, n3.XShift = "-300px", n3.isHelp = true, n3.style.right = "0px", n3.title = d2("help"), n3.onclick = s.handler, g2(n3, true), o2.appendChild(n3), f2.help = n3);
      m2();
    })();
    var e2 = "keydown";
    function p2(e3) {
      if (i.focus(), e3.textOp) {
        let n4 = function() {
          i.focus(), r2 && t2.setChunks(r2), t2.restore(), o.refresh();
        };
        var n3 = n4;
        a && a.setCommandMode();
        var t2 = new C(u2);
        if (!t2) return;
        var r2 = t2.getChunks();
        e3.textOp(r2, n4) || n4();
      }
      e3.execute && e3.execute(a);
    }
    function g2(e3, t2) {
      t2 ? (T.isIE && (e3.onmousedown = function() {
        k.activeElement && k.activeElement !== u2.input || (u2.ieCachedRange = document.selection.createRange(), u2.ieCachedScrollTop = u2.input.scrollTop);
      }), e3.isHelp || (e3.onclick = function() {
        return this.onmouseout && this.onmouseout(), p2(this), false;
      })) : e3.onmouseover = e3.onmouseout = e3.onclick = function() {
      };
    }
    function h2(e3) {
      var t2;
      return "string" == typeof e3 && (e3 = n2[t2 = e3]), function() {
        e3.apply(n2, arguments), t2 && r.commandExecuted(t2);
      };
    }
    function m2() {
      a && (g2(f2.undo, a.canUndo()), g2(f2.redo, a.canRedo()));
    }
    T.isOpera && (e2 = "keypress"), b.addEvent(i, e2, function(e3) {
      if (!e3.ctrlKey && !e3.metaKey || e3.altKey || e3.shiftKey) 9 == e3.keyCode && window.fullScreenEntered && ((t2 = {}).textOp = h2("doTab"), p2(t2), e3.preventDefault && e3.preventDefault(), window.event && (window.event.returnValue = false));
      else {
        var t2 = e3.charCode || e3.keyCode;
        switch (String.fromCharCode(t2).toLowerCase()) {
          case "b":
            p2(f2.bold);
            break;
          case "i":
            p2(f2.italic);
            break;
          case "l":
            p2(f2.link);
            break;
          case "q":
            p2(f2.quote);
            break;
          case "k":
            p2(f2.code);
            break;
          case "g":
            p2(f2.image);
            break;
          case "o":
            p2(f2.olist);
            break;
          case "u":
            p2(f2.ulist);
            break;
          case "m":
            p2(f2.more);
            break;
          case "j":
            p2(f2.fullscreen);
            break;
          case "e":
            p2(f2.exitFullscreen);
            break;
          case "h":
            p2(f2.heading);
            break;
          case "r":
            p2(f2.hr);
            break;
          case "y":
            p2(f2.redo);
            break;
          case "z":
            e3.shiftKey ? p2(f2.redo) : p2(f2.undo);
            break;
          default:
            return;
        }
        e3.preventDefault && e3.preventDefault(), window.event && (window.event.returnValue = false);
      }
    }), b.addEvent(i, "keyup", function(e3) {
      !e3.shiftKey || e3.ctrlKey || e3.metaKey || 13 === (e3.charCode || e3.keyCode) && ((e3 = {}).textOp = h2("doAutoindent"), p2(e3));
    }), T.isIE && b.addEvent(i, "keydown", function(e3) {
      if (27 === e3.keyCode) return false;
    }), this.setUndoRedoButtonStates = m2;
  }
  function S(e2, t2) {
    this.hooks = e2, this.getString = t2;
  }
  Markdown.Editor = function(u2, a, o) {
    (o = "function" == typeof (o = o || {}).handler ? { helpButton: o } : o).strings = o.strings || {}, o.helpButton && (o.strings.help = o.strings.help || o.helpButton.title);
    function i(e2) {
      var t2 = o.strings[e2] || n[e2];
      return "imagename" != e2 && "linkname" != e2 || (o.strings[e2] = null), t2;
    }
    a = a || "";
    var c = this.hooks = new Markdown.HookCollection();
    c.addNoop("onPreviewRefresh"), c.addNoop("postBlockquoteCreation"), c.addFalse("insertImageDialog"), c.addFalse("insertLinkDialog"), c.addNoop("makeButton"), c.addNoop("commandExecuted"), c.addNoop("enterFullScreen"), c.addNoop("enterFakeFullScreen"), c.addNoop("exitFullScreen"), this.getConverter = function() {
      return u2;
    };
    var l, s = this;
    this.run = function() {
      var e2, t2, n2, r;
      l || (l = new p(a), e2 = new S(c, i), t2 = new h(u2, l, function() {
        c.onPreviewRefresh();
      }), /\?noundo/.test(k.location.href) || (n2 = new g(function() {
        t2.refresh(), r && r.setUndoRedoButtonStates();
      }, l), this.textOperation = function(e3) {
        n2.setCommandMode(), e3(), s.refreshPreview();
      }), fullScreenManager = new y(c, i), (r = new m(a, l, c, n2, t2, e2, fullScreenManager, o.helpButton, i)).setUndoRedoButtonStates(), (s.refreshPreview = function() {
        t2.refresh(true);
      })());
    };
  }, t.prototype.findTags = function(e2, t2) {
    var n2, r = this;
    e2 && (n2 = b.extendRegExp(e2, "", "$"), this.before = this.before.replace(n2, function(e3) {
      return r.startTag = r.startTag + e3, "";
    }), n2 = b.extendRegExp(e2, "^", ""), this.selection = this.selection.replace(n2, function(e3) {
      return r.startTag = r.startTag + e3, "";
    })), t2 && (n2 = b.extendRegExp(t2, "", "$"), this.selection = this.selection.replace(n2, function(e3) {
      return r.endTag = e3 + r.endTag, "";
    }), n2 = b.extendRegExp(t2, "^", ""), this.after = this.after.replace(n2, function(e3) {
      return r.endTag = e3 + r.endTag, "";
    }));
  }, t.prototype.trimWhitespace = function(e2) {
    var t2, n2, r = this;
    e2 ? t2 = n2 = "" : (t2 = function(e3) {
      return r.before += e3, "";
    }, n2 = function(e3) {
      return r.after = e3 + r.after, "";
    }), this.selection = this.selection.replace(/^(\s*)/, t2).replace(/(\s*)$/, n2);
  }, t.prototype.skipLines = function(e2, t2, n2) {
    var r, u2;
    if (void 0 === e2 && (e2 = 1), void 0 === t2 && (t2 = 1), e2++, t2++, navigator.userAgent.match(/Chrome/) && "X".match(/()./), this.selection = this.selection.replace(/(^\n*)/, ""), this.startTag = this.startTag + d.$1, this.selection = this.selection.replace(/(\n*$)/, ""), this.endTag = this.endTag + d.$1, this.startTag = this.startTag.replace(/(^\n*)/, ""), this.before = this.before + d.$1, this.endTag = this.endTag.replace(/(\n*$)/, ""), this.after = this.after + d.$1, this.before) {
      for (r = u2 = ""; e2--; ) r += "\\n?", u2 += "\n";
      this.before = this.before.replace(new d((r = n2 ? "\\n*" : r) + "$", ""), u2);
    }
    if (this.after) {
      for (r = u2 = ""; t2--; ) r += "\\n?", u2 += "\n";
      this.after = this.after.replace(new d(r = n2 ? "\\n*" : r, ""), u2);
    }
  }, b.isVisible = function(e2) {
    return window.getComputedStyle ? "none" !== window.getComputedStyle(e2, null).getPropertyValue("display") : e2.currentStyle ? "none" !== e2.currentStyle.display : void 0;
  }, b.addEvent = function(e2, t2, n2) {
    e2.attachEvent ? e2.attachEvent("on" + t2, n2) : e2.addEventListener(t2, n2, false);
  }, b.removeEvent = function(e2, t2, n2) {
    e2.detachEvent ? e2.detachEvent("on" + t2, n2) : e2.removeEventListener(t2, n2, false);
  }, b.fixEolChars = function(e2) {
    return e2 = (e2 = e2.replace(/\r\n/g, "\n")).replace(/\r/g, "\n");
  }, b.extendRegExp = function(e2, t2, n2) {
    null == t2 && (t2 = ""), null == n2 && (n2 = "");
    var r, e2 = e2.toString();
    return e2 = (e2 = e2.replace(/\/([gim]*)$/, function(e3, t3) {
      return r = t3, "";
    })).replace(/(^\/|\/$)/g, ""), new d(e2 = t2 + e2 + n2, r);
  }, v.getTop = function(e2, t2) {
    var n2 = e2.offsetTop;
    if (!t2) for (; e2 = e2.offsetParent; ) n2 += e2.offsetTop;
    return n2;
  }, v.getHeight = function(e2) {
    return e2.offsetHeight || e2.scrollHeight;
  }, v.getWidth = function(e2) {
    return e2.offsetWidth || e2.scrollWidth;
  }, v.getPageSize = function() {
    var e2, t2, n2, r = self.innerHeight && self.scrollMaxY ? (e2 = k.body.scrollWidth, self.innerHeight + self.scrollMaxY) : k.body.scrollHeight > k.body.offsetHeight ? (e2 = k.body.scrollWidth, k.body.scrollHeight) : (e2 = k.body.offsetWidth, k.body.offsetHeight);
    return self.innerHeight ? (t2 = self.innerWidth, n2 = self.innerHeight) : k.documentElement && k.documentElement.clientHeight ? (t2 = k.documentElement.clientWidth, n2 = k.documentElement.clientHeight) : k.body && (t2 = k.body.clientWidth, n2 = k.body.clientHeight), [Math.max(e2, t2), Math.max(r, n2), t2, n2];
  }, w.createBackground = function() {
    var e2 = k.createElement("div"), t2 = e2.style;
    e2.className = "wmd-prompt-background", t2.position = "absolute", t2.top = "0", t2.zIndex = "1000", T.isIE ? t2.filter = "alpha(opacity=50)" : t2.opacity = "0.5";
    var n2 = v.getPageSize();
    return t2.height = n2[1] + "px", T.isIE ? (t2.left = k.documentElement.scrollLeft, t2.width = k.documentElement.clientWidth) : (t2.left = "0", t2.width = "100%"), k.body.appendChild(e2), e2;
  }, w.dialog = function(r, t2, u2, a) {
    var o, i = function(e2) {
      27 === (e2.charCode || e2.keyCode) && c(true);
    }, c = function(e2) {
      return b.removeEvent(k.body, "keydown", i), o.parentNode.removeChild(o), t2(e2), false;
    };
    setTimeout(function() {
      !(function() {
        (o = k.createElement("div")).className = "wmd-prompt-dialog", o.setAttribute("role", "dialog");
        var e2 = k.createElement("div"), t3 = k.createElement("form");
        t3.style;
        t3.onsubmit = function() {
          return c(false);
        }, o.appendChild(t3), t3.appendChild(e2), "function" == typeof r ? r.call(this, e2) : e2.innerHTML = r;
        var n2 = k.createElement("button");
        n2.type = "button", n2.className = "btn btn-s primary", n2.onclick = function() {
          return c(false);
        }, n2.innerHTML = u2;
        e2 = k.createElement("button");
        e2.type = "button", e2.className = "btn btn-s", e2.onclick = function() {
          return c(true);
        }, e2.innerHTML = a, t3.appendChild(n2), t3.appendChild(e2), b.addEvent(k.body, "keydown", i), k.body.appendChild(o);
      })();
    }, 0);
  }, w.prompt = function(r, u2, n2, a, o) {
    var i, c;
    void 0 === u2 && (u2 = "");
    var l = function(e2) {
      27 === (e2.charCode || e2.keyCode) && s(true);
    }, s = function(e2) {
      b.removeEvent(k.body, "keydown", l);
      var t2 = c.value;
      return e2 ? t2 = null : (t2 = t2.replace(/^http:\/\/(https?|ftp):\/\//, "$1://"), /^(?:https?|ftp):\/\//.test(t2) || /^[_a-z0-9-]+:/i.test(t2) || (t2 = "http://" + t2)), i.parentNode.removeChild(i), n2(t2), false;
    };
    setTimeout(function() {
      !(function() {
        (i = k.createElement("div")).className = "wmd-prompt-dialog", i.setAttribute("role", "dialog");
        var e3 = k.createElement("div");
        e3.innerHTML = r, i.appendChild(e3);
        var t3 = k.createElement("form");
        t3.style;
        t3.onsubmit = function() {
          return s(false);
        }, i.appendChild(t3), (c = k.createElement("input")).type = "text", c.value = u2, t3.appendChild(c);
        var n3 = k.createElement("button");
        n3.type = "button", n3.className = "btn btn-s primary", n3.onclick = function() {
          return s(false);
        }, n3.innerHTML = a;
        e3 = k.createElement("button");
        e3.type = "button", e3.className = "btn btn-s", e3.onclick = function() {
          return s(true);
        }, e3.innerHTML = o, t3.appendChild(n3), t3.appendChild(e3), b.addEvent(k.body, "keydown", l), k.body.appendChild(i);
      })();
      var e2, t2 = u2.length;
      void 0 !== c.selectionStart ? (c.selectionStart = 0, c.selectionEnd = t2) : c.createTextRange && ((e2 = c.createTextRange()).collapse(false), e2.moveStart("character", -t2), e2.moveEnd("character", t2), e2.select()), c.focus();
    }, 0);
  };
  var e = S.prototype;
  function y(e2, t2) {
    this.fullScreenBind = false, this.hooks = e2, this.getString = t2, this.isFakeFullScreen = false;
  }
  function u() {
    return document.fullScreen || document.mozFullScreen || document.webkitIsFullScreen || document.msIsFullScreen;
  }
  e.prefixes = "(?:\\s{4,}|\\s*>|\\s*-\\s+|\\s*\\d+\\.|=|\\+|-|_|\\*|#|\\s*\\[[^\n]]+\\]:)", e.unwrap = function(e2) {
    var t2 = new d("([^\\n])\\n(?!(\\n|" + this.prefixes + "))", "g");
    e2.selection = e2.selection.replace(t2, "$1 $2");
  }, e.wrap = function(e2, t2) {
    this.unwrap(e2);
    var t2 = new d("(.{1," + t2 + "})( +|$\\n?)", "gm"), n2 = this;
    e2.selection = e2.selection.replace(t2, function(e3, t3) {
      return new d("^" + n2.prefixes, "").test(e3) ? e3 : t3 + "\n";
    }), e2.selection = e2.selection.replace(/\s+$/, "");
  }, e.doBold = function(e2, t2) {
    return this.doBorI(e2, t2, 2, this.getString("boldexample"));
  }, e.doItalic = function(e2, t2) {
    return this.doBorI(e2, t2, 1, this.getString("italicexample"));
  }, e.doBorI = function(e2, t2, n2, r) {
    e2.trimWhitespace(), e2.selection = e2.selection.replace(/\n{2,}/g, "\n");
    var u2 = /(\**$)/.exec(e2.before)[0], a = /(^\**)/.exec(e2.after)[0], u2 = Math.min(u2.length, a.length);
    n2 <= u2 && (2 != u2 || 1 != n2) ? (e2.before = e2.before.replace(d("[*]{" + n2 + "}$", ""), ""), e2.after = e2.after.replace(d("^[*]{" + n2 + "}", ""), "")) : !e2.selection && a ? (e2.after = e2.after.replace(/^([*_]*)/, ""), e2.before = e2.before.replace(/(\s?)$/, ""), u2 = d.$1, e2.before = e2.before + a + u2) : (e2.selection || a || (e2.selection = r), e2.before = e2.before + (n2 = n2 <= 1 ? "*" : "**"), e2.after = n2 + e2.after);
  }, e.stripLinkDefs = function(e2, a) {
    return e2 = e2.replace(/^[ ]{0,3}\[(\d+)\]:[ \t]*\n?[ \t]*<?(\S+?)>?[ \t]*\n?[ \t]*(?:(\n*)["(](.+?)[")][ \t]*)?(?:\n+|$)/gm, function(e3, t2, n2, r, u2) {
      return a[t2] = e3.replace(/\s*$/, ""), r ? (a[t2] = e3.replace(/["(](.+?)[")]$/, ""), r + u2) : "";
    });
  }, e.addLinkDef = function(e2, t2) {
    var o = 0, i = {};
    e2.before = this.stripLinkDefs(e2.before, i), e2.selection = this.stripLinkDefs(e2.selection, i), e2.after = this.stripLinkDefs(e2.after, i);
    var n2 = "", c = /(\[)((?:\[[^\]]*\]|[^\[\]])*)(\][ ]?(?:\n[ ]*)?\[)(\d+)(\])/g, l = function(e3) {
      o++, e3 = e3.replace(/^[ ]{0,3}\[(\d+)\]:/, "  [" + o + "]:"), n2 += "\n" + e3;
    }, s = function(e3, t3, n3, r, u2, a) {
      return n3 = n3.replace(c, s), i[u2] ? (l(i[u2]), t3 + n3 + r + o + a) : e3;
    };
    e2.before = e2.before.replace(c, s), t2 ? l(t2) : e2.selection = e2.selection.replace(c, s);
    t2 = o;
    return e2.after = e2.after.replace(c, s), e2.after && (e2.after = e2.after.replace(/\n*$/, "")), e2.after || (e2.selection = e2.selection.replace(/\n*$/, "")), e2.after += "\n\n" + n2, t2;
  },
  // 链接/图片以内联 Markdown 插入；再点一次已有标记则移除（toggle-off）
  e.doLinkOrImage = function(chunk, apply, isImage) {
    if (chunk.trimWhitespace(), chunk.findTags(/\s*!?\[/, /\][ ]?(?:\n[ ]*)?(\[.*?\]|\(.*?\))?/), 1 < chunk.endTag.length && 0 < chunk.startTag.length) chunk.startTag = chunk.startTag.replace(/!?\[/, ""), chunk.endTag = "";
    else {
      if (chunk.selection = chunk.startTag + chunk.selection + chunk.endTag, chunk.startTag = chunk.endTag = "", !/\n\n/.test(chunk.selection)) {
        let insertUrl = function(url) {
          overlay.parentNode.removeChild(overlay);
          if (null !== url && "" !== url) {
            chunk.selection = (" " + chunk.selection).replace(/([^\\](?:\\\\)*)(?=[[\]])/g, "$1\\").substr(1), chunk.selection || (chunk.selection = isImage ? editor.getString("imagename") || editor.getString("imagedescription") : editor.getString("linkname") || editor.getString("linkdescription")), chunk.startTag = isImage ? "![" : "[", chunk.endTag = "](" + url + ")";
          }
          apply(), editor.hooks.commandExecuted(isImage ? "doImage" : "doLink");
        };
        var editor = this, overlay = w.createBackground();
        return isImage ? this.hooks.insertImageDialog(insertUrl) || w.prompt(this.getString("imagedialog"), "http://", insertUrl, this.getString("ok"), this.getString("cancel")) : this.hooks.insertLinkDialog(insertUrl) || w.prompt(this.getString("linkdialog"), "http://", insertUrl, this.getString("ok"), this.getString("cancel")), true;
      }
    }
  }, e.doAutoindent = function(t2, e2) {
    var n2 = this, r = false;
    t2.before = t2.before.replace(/(\n|^)[ ]{0,3}([*+-]|\d+[.])[ \t]*\n$/, "\n\n"), t2.before = t2.before.replace(/(\n|^)[ ]{0,3}>[ \t]*\n$/, "\n\n"), t2.before = t2.before.replace(/(\n|^)[ \t]+\n$/, "\n\n"), t2.selection || /^[ \t]*(?:\n|$)/.test(t2.after) || (t2.after = t2.after.replace(/^[^\n]*/, function(e3) {
      return t2.selection = e3, "";
    }), r = true), /(\n|^)[ ]{0,3}([*+-]|\d+[.])[ \t]+.*\n$/.test(t2.before) && n2.doList && n2.doList(t2), /(\n|^)[ ]{0,3}>[ \t]+.*\n$/.test(t2.before) && n2.doBlockquote && n2.doBlockquote(t2), /(\n|^)(\t|[ ]{4,}).*\n$/.test(t2.before) && n2.doCode && n2.doCode(t2), r && (t2.after = t2.selection + t2.after, t2.selection = "");
  }, e.doBlockquote = function(u2, e2) {
    u2.selection = u2.selection.replace(/^(\n*)([^\r]+?)(\n*)$/, function(e3, t3, n3, r2) {
      return u2.before += t3, u2.after = r2 + u2.after, n3;
    }), u2.before = u2.before.replace(/(>[ \t]*)$/, function(e3, t3) {
      return u2.selection = t3 + u2.selection, "";
    }), u2.selection = u2.selection.replace(/^(\s|>)+$/, ""), u2.selection = u2.selection || this.getString("quoteexample");
    var t2 = "", n2 = "";
    if (u2.before) {
      for (var r = u2.before.replace(/\n$/, "").split("\n"), a = false, o = 0; o < r.length; o++) {
        var i = false, c = r[o], a = a && 0 < c.length;
        /^>/.test(c) ? (i = true, !a && 1 < c.length && (a = true)) : i = !!/^[ \t]*$/.test(c) || a, i ? t2 += c + "\n" : (n2 += t2 + c, t2 = "\n");
      }
      /(^|\n)>/.test(t2) || (n2 += t2, t2 = "");
    }
    u2.startTag = t2, u2.before = n2, u2.after && (u2.after = u2.after.replace(/^\n?/, "\n")), u2.after = u2.after.replace(/^(((\n|^)(\n[ \t]*)*>(.+\n)*.*)+(\n[ \t]*)*)/, function(e3) {
      return u2.endTag = e3, "";
    });
    function l(e3) {
      var n3 = e3 ? "> " : "";
      u2.startTag && (u2.startTag = u2.startTag.replace(/\n((>|\s)*)\n$/, function(e4, t3) {
        return "\n" + t3.replace(/^[ ]{0,3}>?[ \t]*$/gm, n3) + "\n";
      })), u2.endTag && (u2.endTag = u2.endTag.replace(/^\n((>|\s)*)\n/, function(e4, t3) {
        return "\n" + t3.replace(/^[ ]{0,3}>?[ \t]*$/gm, n3) + "\n";
      }));
    }
    /^(?![ ]{0,3}>)/m.test(u2.selection) ? (this.wrap(u2, f - 2), u2.selection = u2.selection.replace(/^/gm, "> "), l(true), u2.skipLines()) : (u2.selection = u2.selection.replace(/^[ ]{0,3}> ?/gm, ""), this.unwrap(u2), l(false), !/^(\n|^)[ ]{0,3}>/.test(u2.selection) && u2.startTag && (u2.startTag = u2.startTag.replace(/\n{0,2}$/, "\n\n")), !/(\n|^)[ ]{0,3}>.*$/.test(u2.selection) && u2.endTag && (u2.endTag = u2.endTag.replace(/^\n{0,2}/, "\n\n"))), u2.selection = this.hooks.postBlockquoteCreation(u2.selection), /\n/.test(u2.selection) || (u2.selection = u2.selection.replace(/^(> *)/, function(e3, t3) {
      return u2.startTag += t3, "";
    }));
  },
  // 代码段：多行选区用 ``` 围栏（自动去旧式 4 空格缩进；已围栏则解除），单行/无选区用单个反引号
  e.doCode = function(chunk, postProcessing) {
    if (/\n/.test(chunk.selection)) {
      if (/^```[^\n]*\n/.test(chunk.selection) && /\n```[ \t]*$/.test(chunk.selection)) {
        chunk.selection = chunk.selection.replace(/^```[^\n]*\n/, "").replace(/\n```[ \t]*$/, "");
      } else {
        chunk.selection = chunk.selection.replace(/^(?:[ ]{4}|[ ]{0,3}\t)/gm, ""), chunk.startTag = chunk.before && !/\n$/.test(chunk.before) ? "\n```\n" : "```\n", chunk.endTag = chunk.after && !/^\n/.test(chunk.after) ? "\n```\n" : "\n```";
      }
    } else {
      chunk.trimWhitespace(), chunk.findTags(/`/, /`/), chunk.startTag || chunk.endTag ? chunk.endTag && !chunk.startTag ? (chunk.before += chunk.endTag, chunk.endTag = "") : chunk.startTag = chunk.endTag = "" : (chunk.startTag = chunk.endTag = "`", chunk.selection || (chunk.selection = this.getString("codeexample")));
    }
  }, e.doList = function(e2, t2, n2) {
    function r(e3) {
      return void 0 === n2 && (n2 = /^\s*\d/.test(e3)), e3 = e3.replace(/^[ ]{0,3}([*+-]|\d+[.])\s/gm, function(e4) {
        return i();
      });
    }
    var u2 = /^\n*(([ ]{0,3}([*+-]|\d+[.])[ \t]+.*)(\n.+|\n{2,}([*+-].*|\d+[.])[ \t]+.*|\n{2,}[ \t]+\S.*)*)\n*/, a = "-", o = 1, i = function() {
      var e3;
      return n2 ? (e3 = " " + o + ". ", o++) : e3 = " " + a + " ", e3;
    };
    if (e2.findTags(/(\n|^)*[ ]{0,3}([*+-]|\d+[.])\s+/, null), !e2.before || /\n$/.test(e2.before) || /^\n/.test(e2.startTag) || (e2.before += e2.startTag, e2.startTag = ""), e2.startTag) {
      var c = /\d+[.]/.test(e2.startTag);
      if (e2.startTag = "", e2.selection = e2.selection.replace(/\n[ ]{4}/g, "\n"), this.unwrap(e2), e2.skipLines(), c && (e2.after = e2.after.replace(u2, r)), n2 == c) return;
    }
    var l = 1;
    e2.before = e2.before.replace(/(\n|^)(([ ]{0,3}([*+-]|\d+[.])[ \t]+.*)(\n.+|\n{2,}([*+-].*|\d+[.])[ \t]+.*|\n{2,}[ \t]+\S.*)*)\n*$/, function(e3) {
      return /^\s*([*+-])/.test(e3) && (a = d.$1), l = /[^\n]\n\n[^\n]/.test(e3) ? 1 : 0, r(e3);
    }), e2.selection || (e2.selection = this.getString("litem"));
    var c = i(), s = 1;
    e2.after = e2.after.replace(u2, function(e3) {
      return s = /[^\n]\n\n[^\n]/.test(e3) ? 1 : 0, r(e3);
    }), e2.trimWhitespace(true), e2.skipLines(l, s, true);
    c = (e2.startTag = c).replace(/./g, " ");
    this.wrap(e2, f - c.length), e2.selection = e2.selection.replace(/\n/g, "\n" + c), this.hooks.commandExecuted("doList");
  }, e.doHeading = function(e2, t2) {
    if (e2.selection = e2.selection.replace(/\s+/g, " "), e2.selection = e2.selection.replace(/(^\s+|\s+$)/g, ""), !e2.selection) return e2.startTag = "## ", e2.selection = this.getString("headingexample"), void (e2.endTag = " ##");
    var n2 = 0;
    e2.findTags(/#+[ ]*/, /[ ]*#+/), /#+/.test(e2.startTag) && (n2 = d.lastMatch.length), e2.startTag = e2.endTag = "", e2.findTags(null, /\s?(-+|=+)/), /=+/.test(e2.endTag) && (n2 = 1), /-+/.test(e2.endTag) && (n2 = 2), e2.startTag = e2.endTag = "", e2.skipLines(1, 1);
    n2 = 0 == n2 ? 2 : n2 - 1;
    if (0 < n2) {
      var r = 2 <= n2 ? "-" : "=", u2 = e2.selection.length;
      for (f < u2 && (u2 = f), e2.endTag = "\n"; u2--; ) e2.endTag += r;
    }
  }, e.doHorizontalRule = function(e2, t2) {
    e2.startTag = "----------\n", e2.selection = "", e2.skipLines(2, 1, true);
  }, e.doMore = function(e2, t2) {
    e2.startTag = "<!--more-->\n\n", e2.selection = "", e2.skipLines(2, 0, true);
  }, e.doTab = function(e2, t2) {
    e2.startTag = "    ", e2.selection = "";
  }, y.prototype.doFullScreen = function(e2, t2) {
    var n2 = (function() {
      var e3, t3 = { fullScreenChange: ["onfullscreenchange", "onwebkitfullscreenchange", "onmozfullscreenchange", "onmsfullscreenchange"], requestFullscreen: ["requestFullscreen", "webkitRequestFullScreen", "mozRequestFullScreen", "msRequestFullScreen"], cancelFullscreen: ["cancelFullscreen", "exitFullScreen", "webkitCancelFullScreen", "mozCancelFullScreen", "msCancelFullScreen"] }, n3 = {};
      for (e3 in t3) {
        for (var r2 = t3[e3].length, u2 = false, a = 0; a < r2; a++) {
          var o = t3[e3][a];
          if (void 0 !== document[o] || void 0 !== document.body[o]) {
            n3[e3] = o, u2 = true;
            break;
          }
        }
        if (!u2) return false;
      }
      return n3;
    })(), r = this;
    if (!n2) return alert(r.getString("fullscreenUnsupport")), false;
    this.fullScreenBind || (b.addEvent(document, n2.fullScreenChange.substring(2), function() {
      u() ? (e2.fullscreen.style.display = "none", e2.exitFullscreen.style.display = "", r.hooks.enterFullScreen()) : (e2.fullscreen.style.display = "", e2.exitFullscreen.style.display = "none", r.hooks.exitFullScreen());
    }), this.fullScreenBind = true), t2 ? (r.isFakeFullScreen ? (document.body[n2.requestFullscreen]("webkitRequestFullScreen" == n2.requestFullscreen ? Element.ALLOW_KEYBOARD_INPUT : null), r.isFakeFullScreen = false) : u() || (e2.exitFullscreen.style.display = "", r.hooks.enterFakeFullScreen(), r.isFakeFullScreen = true), window.fullScreenEntered = true) : (r.isFakeFullScreen ? (e2.exitFullscreen.style.display = "none", r.hooks.exitFullScreen()) : u() && document[n2.cancelFullscreen](), r.isFakeFullScreen = false, window.fullScreenEntered = false);
  };
})();
