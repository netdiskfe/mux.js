/**
 * @file:   flv.js
 * @author: tanshaohui
 * @email:  tanshaohui@baidu.com
 * @date:   2016-09-18 16:13:31
 * @last modified by:   tanshaohui
 * @last modified time: 2016-09-30 14:57:09
 */

require('../utils/polyfill.js');
var Stream = require('../utils/stream.js');
var ExpGolomb = require('../utils/exp-golomb.js');

var FlvParseStream,
  ElementaryStream,
  H264Stream,
  AdtsStream,
  MetadataStream;

var MIN_FILE_HEADER_BYTE_COUNT = 9;
var PREV_TAG_BYTE_COUNT = 4;
var TAG_HEADER_BYTE_COUNT = 11;

var PARSE_STATE = {
  FILE_HEADER: 'fileHeader',
  PREV_TAG: 'prevTag',
  TAG: 'tag'
};

var TAG_TYPE = {
  AUDIO: 0x08,
  VIDEO: 0x09,
  SCRIPTDATAOBJECT: 0x12
};

var ADTS_SAMPLING_FREQUENCIES = [
  96000,
  88200,
  64000,
  48000,
  44100,
  32000,
  24000,
  22050,
  16000,
  12000,
  11025,
  8000,
  7350
];

var PROFILES_WITH_OPTIONAL_SPS_DATA = {
  100: true,
  110: true,
  122: true,
  244: true,
  44: true,
  83: true,
  86: true,
  118: true,
  128: true,
  138: true,
  139: true,
  134: true
};

FlvParseStream = function() {
  var state = PARSE_STATE.FILE_HEADER;

  FlvParseStream.prototype.init.call(this);

  var parseFileHeader = function(data, start) {
    var result = {};

    if (data[start + 0] !== 0x46) {
      throw new Error('FLVHeader Signature[0] not "F"');
    }

    if (data[start + 1] !== 0x4C) {
      throw new Error('FLVHeader Signature[1] not "L"');
    }

    if (data[start + 2] !== 0x56) {
      throw new Error('FLVHeader Signature[2] not "V"');
    }

    if (data[start + 3] !== 0x01) {
      throw new Error('FLVHeader Version not 0x01');
    }

    var flags = data[start + 4];

    result.hasAudioTags = (flags & 0x04) ? true : false;
    result.hasVideoTags = (flags & 0x01) ? true : false;

    result.headerLength = new DataView(data.slice(start + 5, start + MIN_FILE_HEADER_BYTE_COUNT).buffer).getUint32(0);

    return result;
  };

  var parseAudioData = function(data, start, end) {
    var result = {type: 'audio'};
    var audioHeader = data[start + 0];
    var soundFormat = (audioHeader >> 4) & 0x0f;

    // AAC
    if (soundFormat === 10) {
      result.codec = 'aac';
      result.packetType = data[start + 1];
      result.data = data.slice(start + 2, end);
    }

    return result;
  };

  var parseVideoData = function(data, start, end) {
    var result = {type: 'video'};
    var videoHeader = data[start + 0];
    var codecID = (videoHeader & 0x0f);
    var frameType = (videoHeader >> 4) & 0x0f;

    result.keyFrame = frameType === 1 ? true : false;

    // AVC
    if (codecID === 7) {
      result.codec = 'avc';
      var packetType = data[start + 1];
      result.packetType = packetType;
      if (packetType === 1) {
        var compositionTime = data[start + 2] << 16;
        compositionTime |= data[start + 3] << 8;
        compositionTime |= data[start + 4];
        if (compositionTime & 0x00800000) {
            compositionTime |= 0xff000000;
        }
        result.cts = compositionTime * 90;
      }
      result.data = data.slice(start + 5, end);
    }

    return result;
  };

  var parseTag = function(data, start) {
    var result = {};
    var type = data[start + 0];
    var tagDataLength = (data[start + 1] << 16 | data[start + 2] << 8 | data[start + 3]);

    switch (type) {
      case TAG_TYPE.AUDIO:
        result = parseAudioData(data, start + TAG_HEADER_BYTE_COUNT, start + TAG_HEADER_BYTE_COUNT + tagDataLength);
        break;
      case TAG_TYPE.VIDEO:
        result = parseVideoData(data, start + TAG_HEADER_BYTE_COUNT, start + TAG_HEADER_BYTE_COUNT + tagDataLength);
        break;
      case TAG_TYPE.SCRIPTDATAOBJECT:
        break;
      default:
        throw new Error('invalid FLVTagType');
    }

    result.trackId = type;
    result.tagDataLength = tagDataLength;
    result.dts = (data[start + 7] << 24) | (data[start + 4] << 16) | (data[start + 5] << 8) | (data[start + 6]) * 90;
    if (result.cts) {
      result.pts = result.dts + result.cts;
    } else {
      result.pts = result.dts;
    }

    return result;
  };

  this.push = function(data) {
    var start = 0;
    var len = data.length;
    var result = {};

    state = PARSE_STATE.FILE_HEADER;

    while (start < len) {
      switch (state) {
        case PARSE_STATE.FILE_HEADER:
          result = parseFileHeader(data, start);
          start += result.headerLength;
          state = PARSE_STATE.PREV_TAG;
          break;
        case PARSE_STATE.PREV_TAG:
          start += PREV_TAG_BYTE_COUNT;
          state = PARSE_STATE.TAG;
          break;
        case PARSE_STATE.TAG:
          result = parseTag(data, start);
          if (result.codec) {
            this.trigger('data', result);
          }
          start += TAG_HEADER_BYTE_COUNT + result.tagDataLength;
          state = PARSE_STATE.PREV_TAG;
          break;
        default:
          throw new Error('invalid FLVParserState');
      }
    }
  };
};
FlvParseStream.prototype = new Stream();

ElementaryStream = function() {
  var audioConfig = {};
  var videoConfig = {};

  ElementaryStream.prototype.init.call(this);

  var parseVideoConfig = function(data) {
    var result = {};
    result.configurationVersion = data[0];
    result.AVCProfileIndication = data[1];
    result.profileCompatibility = data[2];
    result.AVCLevelIndication = data[3];
    result.lengthSizeMinusOne = 1 + (data[4] & 3);
    result.numOfSequenceParameterSets = data[5] & 0x1F;
    var sidx = 6;
    var sequenceParameterSetLength = new DataView(data.slice(sidx, sidx + 2).buffer).getUint16(0);
    sidx += 2;
    result.sequenceParameterSetNALUnits = data.slice(sidx, sidx + sequenceParameterSetLength);
    sidx += sequenceParameterSetLength;
    result.numOfPictureParameterSets = data[sidx++];
    var pictureParameterSetLength = new DataView(data.slice(sidx, sidx + 2).buffer).getUint16(0);
    sidx += 2;
    result.pictureParameterSetNALUnits = data.slice(sidx, sidx + pictureParameterSetLength);
    return result;
  };

  var parseAudioConfig = function(data) {
    var result = {};
    result.audioObjectType = (data[0] & 0xF8) >> 3;
    result.samplingFrequencyIndex = ((data[0] & 0x7) << 1) | (data[1] >> 7);
    result.channelConfiguration = (data[1] >> 3) & 0x0F;
    result.frameLengthFlag = (data[1] >> 2) & 0x01;
    result.dependsOnCoreCoder = (data[1] >> 1) & 0x01;
    result.extensionFlag = data[1] & 0x01;
    return result;
  };

  this.push = function(data) {
    if (data.codec === 'avc') {
      if (data.packetType === 0) {
        videoConfig = parseVideoConfig(data.data);
      } else {
        var lengthSizeMinusOne = videoConfig.lengthSizeMinusOne;
        var array = data.data;
        var i = 0;
        var len = array.length;
        while (i < len) {
          var unitLen = 0;
          for (var j = 0; j < lengthSizeMinusOne; j++) {
              unitLen |= array[i + j] << (8 * (lengthSizeMinusOne - 1 - j));
              if (unitLen < 1) {
                throw new Error('invalid nal unit');
              }
          }
          i += lengthSizeMinusOne;
          this.trigger('data', {
            type: data.type,
            trackId: data.trackId,
            pts: data.pts,
            dts: data.dts,
            data: array.slice(i, i + unitLen),
            config: videoConfig
          });
          i += unitLen;
        }
      }
    } else {
      if (data.packetType === 0) {
        audioConfig = parseAudioConfig(data.data);
      } else {
        this.trigger('data', {
          type: data.type,
          trackId: data.trackId,
          pts: data.pts,
          dts: data.dts,
          data: data.data,
          config: audioConfig
        });
      }
    }
  };
};
ElementaryStream.prototype = new Stream();

AdtsStream = function() {

  AdtsStream.prototype.init.call(this);

  this.push = function(packet) {
    var config = packet.config;
    if (packet.type !== 'audio') {
      // ignore non-audio data
      return;
    }

    this.trigger('data', {
      pts: packet.pts,
      dts: packet.dts,
      sampleCount: 1024,
      audioobjecttype: config.audioObjectType,
      channelcount: config.channelConfiguration,
      samplerate: ADTS_SAMPLING_FREQUENCIES[config.samplingFrequencyIndex],
      samplingfrequencyindex: config.samplingFrequencyIndex,
      // assume ISO/IEC 14496-12 AudioSampleEntry default of 16
      samplesize: 16,
      data: packet.data
    });
  };
};

AdtsStream.prototype = new Stream();

H264Stream = function() {

  H264Stream.prototype.init.call(this);

  var discardEmulationPreventionBytes = function(data) {
    var
      length = data.byteLength,
      emulationPreventionBytesPositions = [],
      i = 1,
      newLength, newData;

    // Find all `Emulation Prevention Bytes`
    while (i < length - 2) {
      if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 0x03) {
        emulationPreventionBytesPositions.push(i + 2);
        i += 2;
      } else {
        i++;
      }
    }

    // If no Emulation Prevention Bytes were found just return the original
    // array
    if (emulationPreventionBytesPositions.length === 0) {
      return data;
    }

    // Create a new array to hold the NAL unit data
    newLength = length - emulationPreventionBytesPositions.length;
    newData = new Uint8Array(newLength);
    var sourceIndex = 0;

    for (i = 0; i < newLength; sourceIndex++, i++) {
      if (sourceIndex === emulationPreventionBytesPositions[0]) {
        // Skip this byte
        sourceIndex++;
        // Remove this position index
        emulationPreventionBytesPositions.shift();
      }
      newData[i] = data[sourceIndex];
    }

    return newData;
  };

  var skipScalingList = function(count, expGolombDecoder) {
    var
      lastScale = 8,
      nextScale = 8,
      j,
      deltaScale;

    for (j = 0; j < count; j++) {
      if (nextScale !== 0) {
        deltaScale = expGolombDecoder.readExpGolomb();
        nextScale = (lastScale + deltaScale + 256) % 256;
      }

      lastScale = (nextScale === 0) ? lastScale : nextScale;
    }
  };

  var readSequenceParameterSet = function(data) {
    var
      frameCropLeftOffset = 0,
      frameCropRightOffset = 0,
      frameCropTopOffset = 0,
      frameCropBottomOffset = 0,
      sarScale = 1,
      expGolombDecoder, profileIdc, levelIdc, profileCompatibility,
      chromaFormatIdc, picOrderCntType,
      numRefFramesInPicOrderCntCycle, picWidthInMbsMinus1,
      picHeightInMapUnitsMinus1,
      frameMbsOnlyFlag,
      scalingListCount,
      sarRatio,
      aspectRatioIdc,
      i;

    expGolombDecoder = new ExpGolomb(data);
    profileIdc = expGolombDecoder.readUnsignedByte(); // profile_idc
    profileCompatibility = expGolombDecoder.readUnsignedByte(); // constraint_set[0-5]_flag
    levelIdc = expGolombDecoder.readUnsignedByte(); // level_idc u(8)
    expGolombDecoder.skipUnsignedExpGolomb(); // seq_parameter_set_id

    // some profiles have more optional data we don't need
    if (PROFILES_WITH_OPTIONAL_SPS_DATA[profileIdc]) {
      chromaFormatIdc = expGolombDecoder.readUnsignedExpGolomb();
      if (chromaFormatIdc === 3) {
        expGolombDecoder.skipBits(1); // separate_colour_plane_flag
      }
      expGolombDecoder.skipUnsignedExpGolomb(); // bit_depth_luma_minus8
      expGolombDecoder.skipUnsignedExpGolomb(); // bit_depth_chroma_minus8
      expGolombDecoder.skipBits(1); // qpprime_y_zero_transform_bypass_flag
      if (expGolombDecoder.readBoolean()) { // seq_scaling_matrix_present_flag
        scalingListCount = (chromaFormatIdc !== 3) ? 8 : 12;
        for (i = 0; i < scalingListCount; i++) {
          if (expGolombDecoder.readBoolean()) { // seq_scaling_list_present_flag[ i ]
            if (i < 6) {
              skipScalingList(16, expGolombDecoder);
            } else {
              skipScalingList(64, expGolombDecoder);
            }
          }
        }
      }
    }

    expGolombDecoder.skipUnsignedExpGolomb(); // log2_max_frame_num_minus4
    picOrderCntType = expGolombDecoder.readUnsignedExpGolomb();

    if (picOrderCntType === 0) {
      expGolombDecoder.readUnsignedExpGolomb(); // log2_max_pic_order_cnt_lsb_minus4
    } else if (picOrderCntType === 1) {
      expGolombDecoder.skipBits(1); // delta_pic_order_always_zero_flag
      expGolombDecoder.skipExpGolomb(); // offset_for_non_ref_pic
      expGolombDecoder.skipExpGolomb(); // offset_for_top_to_bottom_field
      numRefFramesInPicOrderCntCycle = expGolombDecoder.readUnsignedExpGolomb();
      for (i = 0; i < numRefFramesInPicOrderCntCycle; i++) {
        expGolombDecoder.skipExpGolomb(); // offset_for_ref_frame[ i ]
      }
    }

    expGolombDecoder.skipUnsignedExpGolomb(); // max_num_ref_frames
    expGolombDecoder.skipBits(1); // gaps_in_frame_num_value_allowed_flag

    picWidthInMbsMinus1 = expGolombDecoder.readUnsignedExpGolomb();
    picHeightInMapUnitsMinus1 = expGolombDecoder.readUnsignedExpGolomb();

    frameMbsOnlyFlag = expGolombDecoder.readBits(1);
    if (frameMbsOnlyFlag === 0) {
      expGolombDecoder.skipBits(1); // mb_adaptive_frame_field_flag
    }

    expGolombDecoder.skipBits(1); // direct_8x8_inference_flag
    if (expGolombDecoder.readBoolean()) { // frame_cropping_flag
      frameCropLeftOffset = expGolombDecoder.readUnsignedExpGolomb();
      frameCropRightOffset = expGolombDecoder.readUnsignedExpGolomb();
      frameCropTopOffset = expGolombDecoder.readUnsignedExpGolomb();
      frameCropBottomOffset = expGolombDecoder.readUnsignedExpGolomb();
    }
    if (expGolombDecoder.readBoolean()) {
      // vui_parameters_present_flag
      if (expGolombDecoder.readBoolean()) {
        // aspect_ratio_info_present_flag
        aspectRatioIdc = expGolombDecoder.readUnsignedByte();
        switch (aspectRatioIdc) {
          case 1: sarRatio = [1, 1]; break;
          case 2: sarRatio = [12, 11]; break;
          case 3: sarRatio = [10, 11]; break;
          case 4: sarRatio = [16, 11]; break;
          case 5: sarRatio = [40, 33]; break;
          case 6: sarRatio = [24, 11]; break;
          case 7: sarRatio = [20, 11]; break;
          case 8: sarRatio = [32, 11]; break;
          case 9: sarRatio = [80, 33]; break;
          case 10: sarRatio = [18, 11]; break;
          case 11: sarRatio = [15, 11]; break;
          case 12: sarRatio = [64, 33]; break;
          case 13: sarRatio = [160, 99]; break;
          case 14: sarRatio = [4, 3]; break;
          case 15: sarRatio = [3, 2]; break;
          case 16: sarRatio = [2, 1]; break;
          case 255: {
            sarRatio = [expGolombDecoder.readUnsignedByte() << 8 |
                        expGolombDecoder.readUnsignedByte(),
                        expGolombDecoder.readUnsignedByte() << 8 |
                        expGolombDecoder.readUnsignedByte() ];
            break;
          }
        }
        if (sarRatio) {
          sarScale = sarRatio[0] / sarRatio[1];
        }
      }
    }
    return {
      profileIdc: profileIdc,
      levelIdc: levelIdc,
      profileCompatibility: profileCompatibility,
      width: Math.ceil((((picWidthInMbsMinus1 + 1) * 16) - frameCropLeftOffset * 2 - frameCropRightOffset * 2) * sarScale),
      height: ((2 - frameMbsOnlyFlag) * (picHeightInMapUnitsMinus1 + 1) * 16) - (frameCropTopOffset * 2) - (frameCropBottomOffset * 2)
    };
  };

  this.push = function(packet) {
    var data = packet.data;
    if (packet.type !== 'video') {
      // ignore non-video data
      return;
    }

    var event = {
      trackId: packet.trackId,
      dts: packet.dts,
      pts: packet.pts,
      data: data
    };

    switch (data[0] & 0x1f) {
      case 0x05:
        event.nalUnitType = 'slice_layer_without_partitioning_rbsp_idr';
        break;
      case 0x06:
        event.nalUnitType = 'sei_rbsp';
        event.escapedRBSP = discardEmulationPreventionBytes(data.subarray(1));
        break;
      case 0x07:
        event.nalUnitType = 'seq_parameter_set_rbsp';
        event.escapedRBSP = discardEmulationPreventionBytes(data.subarray(1));
        event.config = readSequenceParameterSet(event.escapedRBSP);
        break;
      case 0x08:
        event.nalUnitType = 'pic_parameter_set_rbsp';
        break;
      case 0x09:
        event.nalUnitType = 'access_unit_delimiter_rbsp';
        break;

      default:
        break;
    }

    this.trigger('data', {
      nalUnitType: 'access_unit_delimiter_rbsp',
      trackId: packet.trackId,
      dts: packet.dts,
      pts: packet.pts,
      data: Uint8Array.of(9, 240)
    });

    if (event.nalUnitType === 'slice_layer_without_partitioning_rbsp_idr') {
      var sequenceParameterSetNALUnits = packet.config.sequenceParameterSetNALUnits;
      var escapedRBSP = discardEmulationPreventionBytes(sequenceParameterSetNALUnits.subarray(1));
      var config = readSequenceParameterSet(escapedRBSP);
      this.trigger('data', {
        nalUnitType: 'seq_parameter_set_rbsp',
        trackId: packet.trackId,
        dts: packet.dts,
        pts: packet.pts,
        data: sequenceParameterSetNALUnits,
        escapedRBSP: escapedRBSP,
        config: config
      });
      this.trigger('data', {
        nalUnitType: 'pic_parameter_set_rbsp',
        trackId: packet.trackId,
        dts: packet.dts,
        pts: packet.pts,
        data: packet.config.pictureParameterSetNALUnits
      });
    }

    this.trigger('data', event);
  };
};

H264Stream.prototype = new Stream();

MetadataStream = function(options) {
    MetadataStream.prototype.init.call(this);
    this.dispatchType = TAG_TYPE.SCRIPTDATAOBJECT.toString(16);
};

MetadataStream.prototype = new Stream();

var flv = {
  FlvParseStream: FlvParseStream,
  ElementaryStream: ElementaryStream,
  H264Stream: H264Stream,
  AdtsStream: AdtsStream,
  MetadataStream: MetadataStream
};

module.exports = flv;
