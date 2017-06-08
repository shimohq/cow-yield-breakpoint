'use strict';

const assert = require('assert');
const Module = require('module');

const _ = require('lodash');
const glob = require('glob');
const uuid = require('node-uuid');
const esprima = require('esprima');
const shimmer = require('shimmer');
const escodegen = require('escodegen');
const debug = require('debug')('cow-yield-breakpoint');

const defaultOpt = {
  nodir: true,
  absolute: true,
  loggerName: 'logger',
  requestIdPath: 'requestId'
};

module.exports = function (opt) {
  opt = _.defaults(opt || {}, defaultOpt);
  debug('options: %j', opt);

  const loggerName = opt.loggerName;
  const requestIdPath = opt.requestIdPath;
  const files = opt.files;
  const exclude_files = opt.exclude_files || [];
  const store = opt.store || { save: (record) => console.log('%j', record) };
  const yieldCondition = opt.yieldCondition;
  assert(requestIdPath && _.isString(requestIdPath), '`requestIdPath` option must be string');
  assert(files && _.isArray(files), '`files`{array} option required');
  assert(_.isArray(exclude_files), '`exclude_files`{array} option required');
  assert(store && _.isFunction(store.save), '`store.save`{function} option required, see: koa-yield-breakpoint-mongodb');
  if (yieldCondition) {
    assert(_.isFunction(yieldCondition), '`yieldCondition` option must be function');
  }

  // add global logger
  global[loggerName] = function *(req, fn, fnStr, filename) {
    if (!req) {
      return yield fn;
    }
    let requestId = _.get(req, requestIdPath);
    if (requestId) {
      _logger('beforeYield');
    }
    const result = yield fn;
    if (requestId) {
      _logger('afterYield');
    }
    return result;

    function _logger(type) {
      const record = {
        requestId,
        step: ++req.step,
        filename,
        timestamp: new Date(),
        status: type,
        fn: fnStr,
        url: req.method + ' ' + req.host + req.path
      };
      addTake(req, record);
      debug(record);

      store.save(record, req);
    }
  };

  let filenames = [];
  files.forEach(filePattern => {
    if (filePattern) {
      filenames = filenames.concat(glob.sync(filePattern, opt));
    }
  });
  exclude_files.forEach(filePattern => {
    if (filePattern) {
      _.pullAll(filenames, glob.sync(filePattern, opt));
    }
  });
  filenames = _.uniq(filenames);
  debug('matched files: %j', filenames);

  // wrap Module.prototype._compile
  shimmer.wrap(Module.prototype, '_compile', function (__compile) {
    return function koaBreakpointCompile(content, filename) {
      if (!_.includes(filenames, filename)) {
        try {
          return __compile.call(this, content, filename);
        } catch(e) {
          console.error('cannot compile file: %s', filename);
          console.error(e.stack);
          process.exit(1);
        }
      }

      let parsedCodes;
      try {
        parsedCodes = esprima.parse(content, { loc: true });
      } catch (e) {
        console.error('cannot parse file: %s', filename);
        console.error(e.stack);
        process.exit(1);
      }

      findYieldAndWrapLogger(parsedCodes);
      try {
        content = escodegen.generate(parsedCodes, {
          format: { indent: { style: '  ' } },
          sourceMap: filename,
          sourceMapWithCode: true
        });
      } catch (e) {
        console.error('cannot generate code for file: %s', filename);
        console.error(e.stack);
        process.exit(1);
      }
      debug('file %s regenerate codes:\n%s', filename, content.code);
      return __compile.call(this, content.code, filename);

      function findYieldAndWrapLogger(node) {
        if (!node || typeof node !== 'object') {
          return;
        }
        let condition = {
          wrapYield: true,
          deep: true
        };

        if (node.hasOwnProperty('type') && node.type === 'YieldExpression' && !node.__skip) {
          const codeLine = node.loc.start;
          const __argument = node.argument;
          const __expressionStr = escodegen.generate(__argument);

          const expressionStr = `global.${loggerName}(typeof req === 'object' ? req : null, ${__expressionStr}, ${JSON.stringify(__expressionStr)}, ${JSON.stringify(filename + ':' + codeLine.line + ':' + codeLine.column)})`;

          if (yieldCondition) {
            condition = yieldCondition(filename, __expressionStr, __argument) || condition;
            assert(typeof condition === 'object', '`yieldCondition` must return a object');
          }
          if (condition.wrapYield) {
            try {
              node.argument = esprima.parse(expressionStr, { loc: true }).body[0].expression;
              try {
                // skip process this YieldExpression
                node.argument.arguments[1].body.body[0].argument.__skip = true;
                // try correct loc
                node.argument.arguments[1].body.body[0].argument.argument = __argument;
              } catch (e) {/* ignore */}
            } catch (e) {
              console.error('cannot parse expression:');
              console.error(expressionStr);
              console.error(e.stack);
              process.exit(1);
            }
          }
        }
        if (condition.deep) {
          for (const key in node) {
            if (node.hasOwnProperty(key)) {
              findYieldAndWrapLogger(node[key]);
            }
          }
        }
      }
    };
  });

  return function koaYieldBreakpoint(req, res, next) {
    if (!_.get(req, requestIdPath)) {
      _.set(req, requestIdPath, uuid.v4());
    }
    req.step = 0;
    req.timestamps = {};
    _logger('start');

    const _end = res.end;
    res.end = function end() {
      _logger('end');
      return _end.apply(res, arguments);
    };
    return next();

    function _logger(type) {
      const record = {
        requestId: _.get(req, requestIdPath),
        timestamp: new Date(),
        status: type,
        step: ++req.step,
        url: req.method + ' ' + req.host + req.path
      };

      addTake(req, record);
      debug(record);

      store.save(record, req, res);
    }
  };
};

function addTake(req, record) {
  req.timestamps[record.step] = record.timestamp;
  const prevTimestamp = req.timestamps[record.step - 1];
  if (prevTimestamp) {
    record.take = record.timestamp - prevTimestamp;
  } else {
    // start default 0
    record.take = 0;
  }
}
