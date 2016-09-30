/**
 * @file:   polyfill.js
 * @author: tanshaohui
 * @email:  tanshaohui@baidu.com
 * @date:   2016-09-18 20:29:12
 * @last modified by:   tanshaohui
 * @last modified time: 2016-09-30 22:05:03
 */

if (typeof Uint8Array !== 'undefined' && !Uint8Array.prototype.slice) {
  Uint8Array.prototype.slice = function(start, end) {
    var that = this;
    if (end === undefined) {
      end = that.length;
    }
    if (end > that.length) {
      end = that.length;
    }
    if (end < start) {
      start = end;
    }
    var result = new Uint8Array(end - start);
    for (var i = 0; i < result.length; i++) {
      result[i] = that[i + start];
    }
    return result;
  };
}

if (typeof Uint8Array !== 'undefined' && !Uint8Array.of) {
  Uint8Array.of = function() {
    var args = arguments;
    var result = new Uint8Array(args.length);
    for (var i = 0; i < args.length; i++) {
      result[i] = args[i];
    }
    return result;
  };
}

if (typeof Uint8Array !== 'undefined' && !Uint8Array.prototype.concat) {
  Uint8Array.prototype.concat = function() {
    var args = arguments;
    var that = this;
    var totalLength = that.length;
    for (var i = 0; i < args.length; i++) {
      totalLength += args[i].byteLength;
    }
    var result = new Uint8Array(totalLength);
    var offset = 0;
    result.set(that, offset);
    offset += that.length;
    for (var i = 0; i < args.length; i++) {
      result.set(args[i], offset);
      offset += args[i].byteLength;
    }
    return result;
  };
}
