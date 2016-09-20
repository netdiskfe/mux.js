/**
 * @file:   polyfill.js
 * @author: tanshaohui
 * @email:  tanshaohui@baidu.com
 * @date:   2016-09-18 20:29:12
 * @last modified by:   tanshaohui
 * @last modified time: 2016-09-20 11:24:21
 */

if (typeof ArrayBuffer !== 'undefined' && !ArrayBuffer.prototype.slice) {
  ArrayBuffer.prototype.slice = function(start, end) {
    var that = new Uint8Array(this);
    if (end === undefined) {
      end = that.length;
    }
    var result = new ArrayBuffer(end - start);
    var resultArray = new Uint8Array(result);
    for (var i = 0; i < resultArray.length; i++) {
      resultArray[i] = that[i + start];
    }
    return result;
  };
}

if (typeof Uint8Array !== 'undefined' && !Uint8Array.prototype.concat) {
  Uint8Array.prototype.concat = function() {
    var arrays = arguments;
    var that = this;
    var totalLength = that.length;
    for (var i = 0; i < arrays.length; i++) {
      totalLength += arrays[i].byteLength;
    }
    var result = new Uint8Array(totalLength);
    var offset = 0;
    result.set(that, offset);
    offset += that.length;
    for (var i = 0; i < arrays.length; i++) {
      result.set(arrays[i], offset);
      offset += arrays[i].byteLength;
    }
    return result;
  };
}
