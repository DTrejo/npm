
module.exports = publish

var npm = require("./npm.js")
  , registry = npm.registry
  , log = require("npmlog")
  , tar = require("./utils/tar.js")
  , sha = require("./utils/sha.js")
  , path = require("path")
  , readJson = require("./utils/read-json.js")
  , fs = require("graceful-fs")
  , lifecycle = require("./utils/lifecycle.js")
  , chain = require("slide").chain
  , output = require("./utils/output.js")

publish.usage = "npm publish <tarball>"
              + "\nnpm publish <folder>"
              + "\n\nPublishes '.' if no argument supplied"

publish.completion = function (opts, cb) {
  // publish can complete to a folder with a package.json
  // or a tarball, or a tarball url.
  // for now, not yet implemented.
  return cb()
}

function publish (args, isRetry, cb) {
  if (typeof cb !== "function") cb = isRetry, isRetry = false
  if (args.length === 0) args = ["."]
  if (args.length !== 1) return cb(publish.usage)

  log.verbose("publish", args)
  var arg = args[0]
  // if it's a local folder, then run the prepublish there, first.
  readJson(path.resolve(arg, "package.json"), function (er, data) {
    // error is ok.  could be publishing a url or tarball
    // however, that means that we will not have automatically run
    // the prepublish script, since that gets run when adding a folder
    // to the cache.
    if (er) return cacheAddPublish(arg, false, isRetry, cb)

    cacheAddPublish(arg, true, isRetry, cb)
  })
}

function cacheAddPublish (arg, didPre, isRetry, cb) {
  npm.commands.cache.add(arg, function (er, data) {
    if (er) return cb(er)
    log.silly("publish", data)
    var cachedir = path.resolve( npm.cache
                               , data.name
                               , data.version
                               , "package" )
    chain
      ( [ !didPre && [lifecycle, data, "prepublish", cachedir]
        , [publish_, arg, data, isRetry, cachedir]
        , [lifecycle, data, "publish", cachedir]
        , [lifecycle, data, "postpublish", cachedir] ]
      , cb )
  })
}

function publish_ (arg, data, isRetry, cachedir, cb) {
  if (!data) return cb(new Error("no package.json file found"))

  // check for publishConfig hash
  if (data.publishConfig) {
    Object.keys(data.publishConfig).forEach(function (k) {
      log.info("publishConfig", k + "=" + data.publishConfig[k])
      npm.config.set(k, data.publishConfig[k])
    })
  }

  delete data.modules
  if (data.private) return cb(new Error
    ("This package has been marked as private\n"
    +"Remove the 'private' field from the package.json to publish it."))

  // pre-build
  var bd = data.scripts
           && ( data.scripts.preinstall
             || data.scripts.install
             || data.scripts.postinstall )
           && npm.config.get("bindist")
           && npm.config.get("bin-publish")
  preBuild(data, bd, function (er, tb) {
    if (er) return cb(er)
    return regPublish(data, tb, isRetry, arg, cachedir, cb)
  })
}


function preBuild (data, bd, cb) {
  if (!bd) return cb()
  // unpack to cache/n/v/build
  // build there
  // pack to cache/package-<bd>.tgz
  var cf = path.resolve(npm.cache, data.name, data.version)
  var pb = path.resolve(cf, "build")
    , buildTarget = path.resolve(pb, "node_modules", data.name)
    , tb = path.resolve(cf, "package-"+bd+".tgz")
    , sourceBall = path.resolve(cf, "package.tgz")

  log.verbose("preBuild", "about to cache unpack")
  log.verbose("preBuild", "tarball = %s", sourceBall)
  npm.commands.install(pb, sourceBall, function (er) {
    log.info("preBuild", "done", data._id)
    // build failure just means that we can't prebuild
    if (er) {
      log.warn("preBuild", "failed (continuing without prebuild)", bd, er)
      return cb()
    }
    // now strip the preinstall/install scripts
    // they've already been run.
    var pbj = path.resolve(buildTarget, "package.json")
    readJson(pbj, function (er, pbo) {
      if (er) return cb(er)
      if (pbo.scripts) {
        delete pbo.scripts.preinstall
        delete pbo.scripts.install
        delete pbo.scripts.postinstall
      }
      pbo.prebuilt = bd
      pbo.files = pbo.files || []
      pbo.files.push("build")
      pbo.files.push("build/")
      pbo.files.push("*.node")
      pbo.files.push("*.js")
      fs.writeFile(pbj, JSON.stringify(pbo, null, 2), function (er) {
        if (er) return cb(er)
        tar.pack(tb, buildTarget, pbo, true, function (er) {
          if (er) return cb(er)
          // try to validate the shasum, too
          sha.get(tb, function (er, shasum) {
            if (er) return cb(er)
            // binary distribution requires shasum checking.
            if (!shasum) return cb()
            data.dist.bin = data.dist.bin || {}
            data.dist.bin[bd] = data.dist.bin[bd] || {}
            data.dist.bin[bd].shasum = shasum
            return cb(null, tb)
          })
        })
      })
    })
  })
}

function regPublish (data, prebuilt, isRetry, arg, cachedir, cb) {
  cb = rollbackFailure(data, cb)

  // check to see if there's a README.md in there.
  var readme = path.resolve(cachedir, "README.md")
    , tarball = cachedir + ".tgz"

  fs.readFile(readme, function (er, readme) {
    // ignore error.  it's an optional feature

    registry.publish(data, tarball, readme, function (er) {
      if (er && er.errno === npm.EPUBLISHCONFLICT
          && npm.config.get("force") && !isRetry) {
        log.warn("publish", "Forced publish over "+data._id)
        return npm.commands.unpublish([data._id], function (er) {
          // ignore errors.  Use the force.  Reach out with your feelings.
          publish([arg], true, cb)
        })
      }
      if (er) return cb(er)
      output.write("+ " + data._id, cb)
    })
  })
}

function rollbackFailure (data, cb) { return function (er) {
  if (!er) return cb()
  npm.ROLLBACK = true
  log.error("publish failed", er)
  log.info("publish failed", "rollback")
  npm.commands.unpublish([data.name+"@"+data.version], function (er_) {
    if (er_) {
      log.error("rollback failed", er_)
      log.error( "rollback failed"
               , "Invalid data in registry! Please report this.")
    } else log.info("publish failed", "rolled back")
    cb(er)
  })
}}
