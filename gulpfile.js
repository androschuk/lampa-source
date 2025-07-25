import { src, dest, series, parallel, task, watch } from 'gulp';
import concat from 'gulp-concat';
import uglifycss from 'gulp-uglifycss';
import browserSync from 'browser-sync';
import newer from 'gulp-newer';
import gulpSass from 'gulp-sass'
import * as dartSass from 'sass'
import autoprefixer from 'gulp-autoprefixer';
import fileinclude from 'gulp-file-include';
import replace from 'gulp-replace';
import { readFileSync, readdirSync, statSync, writeFileSync, existsSync } from 'fs';
import path from 'path'
import worker from 'rollup-plugin-web-worker-loader';
import { createHash } from 'crypto';
import source from 'vinyl-source-stream';
import buffer from 'vinyl-buffer';
import rollup from '@rollup/stream';
import { join } from 'path';
import { parse } from 'doctrine';
import esbuild from 'rollup-plugin-esbuild';
import terser from '@rollup/plugin-terser';
import imagemin from 'gulp-imagemin';
import commonjs from '@rollup/plugin-commonjs'; // Add support for require() syntax
import nodeResolve from '@rollup/plugin-node-resolve'; // Add support for importing from node_modules folder like import x from 'module-name'
import plumber from 'gulp-plumber'; //For error handling
import gulpIf from 'gulp-if';

function handleError(error) {
    const msg = error?.message || error;
    const stack = error?.stack || '';
    console.error('❌ Gulp error:', msg);
    if (stack && stack !== msg) 
        console.error(stack);
    this?.emit?.('end');
}

process.on('uncaughtException', error => {
    console.error('❌ Uncaught exception:', error?.stack || error);
    process.exit(1);
});

process.on('unhandledRejection', error => {
    console.error('❌ Unhandled rejection:', error?.stack || error);
    process.exit(1);
});

const browser = browserSync.create()
const sass = gulpSass(dartSass);

var srcFolder = './src/';
var dstFolder = './dest/';
var pubFolder = './public/';
var bulFolder = './build/';
var idxFolder = './index/';
var plgFolder = './plugins/';
var docFolder = './build/doc/';

const cssAutoprefixerOptions = ['last 100 versions', '> 1%', 'ie 8', 'ie 7', 'ios 6', 'android 4'];

var isDebugEnabled = false;

function buildAppJs() {
      return prepareRollup(srcFolder, "app.js")
      .pipe(replace(/return kIsNodeJS/g, "return false"))
      .pipe(dest(dstFolder))
      
}

function prepareRollup(inputFolder, fileName){
    return rollup({
        input: join(inputFolder, fileName),
        plugins: [
            esbuild({ target: 'es2017' }),
            commonjs, 
            nodeResolve,
            worker(),
            terser()
        ],
        output: {
          format: 'iife',
          sourcemap: isDebugEnabled ? 'inline' : false,
        },
        onwarn: msg => {
          // console.warn(msg); TODO: temporary disable
        }
      })
      .pipe(source(fileName))
      .pipe(plumber({ errorHandler: handleError }))
      .pipe(buffer())
}

function getFileHash(filePath) {
    try {
        if (!existsSync(filePath)) {
            console.error(`File not found: ${filePath}`);
            return null;
        }

        const fileBuffer = readFileSync(path);
        const hashSum = createHash('md5');
        hashSum.update(fileBuffer);
        return hashSum.digest('hex');
    } catch (error) {
        console.error(`Error reading file ${filePath}:`, error.message);
        return null;
    }    
}

function buildPlugins() {
    const directories = readdirSync(plgFolder)
        .filter(name => statSync(join(plgFolder, name)).isDirectory())

    const tasks = directories.map(folder => {
        return new Promise((resolve, reject) => {
            console.log(` - ${folder}`)
            prepareRollup(plgFolder, `${folder}/${folder}.js`)
            .pipe(fileinclude({
                prefix: '@@',
                basepath: '@file'
            }))
            .pipe(dest(dstFolder))
            .on('end', resolve)
            .on('error', reject);        
        });
    });

    return Promise.all(tasks);
}

function buildStyles({ inputGlob, outputDir, options = {} }) {
    const {
      uglify = { enabled: false },
      replaceNewlines = false,
      replaceQuotes = false
    } = options;
  
    return src(inputGlob)
      .pipe(plumber({ errorHandler: handleError }))
      .pipe(sass.sync().on('error', sass.logError)) // Convert Sass to CSS
      .pipe(autoprefixer({ overrideBrowserslist: cssAutoprefixerOptions, cascade: true }))
      .pipe(gulpIf(uglify.enabled, uglifycss(uglify.options)))
      .pipe(gulpIf(replaceNewlines, replace(/\n/g, '')))
      .pipe(gulpIf(replaceQuotes, replace(/"/g, "'")))
      .pipe(dest(outputDir))
}

function buildAppStyles() {
    return buildStyles({
      inputGlob: join(srcFolder, 'sass/*.scss'),
      outputDir: join(pubFolder, 'css'),
      options: {
        uglify: { enabled: true }
      }
    });
}

function buildPluginStyles() {
    return buildStyles({
      inputGlob: join(plgFolder, '**/*.scss'),
      outputDir: plgFolder,
      options: {
        replaceNewlines: true,
        replaceQuotes: true,
        uglify: {
            enabled: true,
            options: {
              uglyComments: true,
              maxLineLen: 120
            }
        }        
      }
    });
}

function copyAppJsToWeb(){
    return src([dstFolder + 'app.js'])
        .pipe(plumber({ errorHandler: handleError }))
        .pipe(dest(bulFolder + 'web/'))
}

function copyPlugins(done){
    readdirSync(dstFolder).filter( file => {
        return statSync(dstFolder +'/' + file).isDirectory();
    }).forEach(folder => {
        src([dstFolder + folder + '/' + folder + '.js'])
        .pipe(plumber({ errorHandler: handleError }))
        .pipe(dest(bulFolder+'web/plugins'));
    });

    done();
}

function buildManifest(done){
    try {
        var manifest = readFileSync(srcFolder + 'utils/manifest.js', 'utf8')
        var hash     = getFileHash(dstFolder + '/app.min.js')

        var app_version = manifest.match(/app_version: '(.*?)',/)[1]
        var css_version = manifest.match(/css_version: '(.*?)',/)[1]

        var manifestData = {
            app_version: app_version,
            css_version: css_version,
            css_digital: parseInt(css_version.replace(/\./g,'')),
            app_digital: parseInt(app_version.replace(/\./g,'')),
            time: Date.now(),
            hash: hash
        }

        console.log('✅ Assembly info:', manifestData)

        writeFileSync(idxFolder+'github/assembly.json', JSON.stringify(manifestData, null, 4))

        done();
    } catch (error) {
        console.error('❌ Error building manifest:', error.message);
        done(error);
    }        
}

function copyAppMiniJs(path){
    return src(dstFolder + '/app.min.js')
        .pipe(plumber({ errorHandler: handleError }))
        .pipe(dest(bulFolder + path + '/'))
}

function copyLanguages(){
    return src(srcFolder + '/lang/*.js')
        .pipe(plumber({ errorHandler: handleError }))
        .pipe(dest(pubFolder + '/lang'))
}

function copyIndexFolder(path){
    return src(idxFolder + `/${path}/**/*`)
        .pipe(plumber({ errorHandler: handleError }))
        .pipe(dest(bulFolder + `${path}/`))
}

function copyPublicFolder(path){
    const destPath = join(bulFolder, path + '/');
    return src(join(pubFolder, '**/*'), { encoding: false})
        .pipe(plumber({ errorHandler: handleError }))
        .pipe(newer(destPath))
        .pipe(imagemin( { silent: false }))
        .pipe(dest(destPath));
}

function copyDocFolder(){
    return src([idxFolder + 'doc/' + '**/*'])
        .pipe(plumber({ errorHandler: handleError }))
        .pipe(newer(docFolder))
        .pipe(dest(docFolder));
}

/** watch mode **/
function watch_changes(done){
    // src
    watch('src/sass/*.scss', series(buildAppStyles, reloadBrowser));
    watch(['src/**/*.js', '!src/lang/*.js'], series(buildAppJs, copyAppJsToWeb, reloadBrowser));
    watch('src/lang/*.js', series(copyLanguages, reloadBrowser));
    // plugins
    watch('plugins/**/*.js', series(build_plugins, copyPlugins, reloadBrowser));
    watch('plugins/**/*.scss', series(build_plugins, copyPlugins, reloadBrowser));
    

    done();
}

function browser_syncup(done) {
    browser.init({
        server: {
            baseDir: bulFolder + 'web/'
        },
        open: false,
        notify: false,
        ghostMode: false,
    });

    done();
}

function reloadBrowser(done) {
    browser.reload();
    done();
}

function minifyAppJs() {
    return src([dstFolder + 'app.js'])
        .pipe(plumber({ errorHandler: handleError }))
        .pipe(concat('app.min.js'))
        .pipe(dest(dstFolder));
}

function enableDebugMode(done){
    console.log("🔒 build with sourcemaps")
    isDebugEnabled = true;
    done()
}

function buildDocumentation(done) {
    try {
        const data = []
        let scanned = 0

        console.log('🔎 Scanning documents:')

        function scan(directory){
            readdirSync(directory)
            .filter(file => path.extname(file) === '.js' || statSync(directory +'/' + file).isDirectory())
            .forEach(file => {
                const filePath = join(directory, file)
                const stat = statSync(filePath)

                if (stat.isDirectory()){ 
                    scan(filePath)
                } else {
                    scanned++
                    const code = readFileSync(filePath, 'utf8') + ''

                    const comments = code.match(/\/\*[\s\S]*?\*\/|([^:]|^)\/\/.*$/gm)

                    if (!comments){
                        return;
                    }
                    console.log(` - ${filePath}`)

                    comments.forEach(comment => {
                        try {
                            const parsedComment = parse(comment, { unwrap: true });

                            if (!parsedComment.tags.find(t => t.title === 'doc')) 
                                return;

                            const params = parsedComment.tags.filter(t => ['doc', 'name', 'alias'].indexOf(t.title) == -1)
                            const category = parsedComment.tags.find(t => t.title == 'alias')
                            const name = parsedComment.tags.find(t => t.title == 'name')
                            
                            data.push({
                                file: filePath,
                                params: params.map(p => ({param: p.name || p.title, desc: p.description || '', type: p.type ? p.type.name : 'any'})),
                                desc: parsedComment.description,
                                category: category ? category.name : 'other',
                                name: name ? name.name : 'unknown'
                            })
                        } catch (parseError) {
                            console.warn(`Error parsing comment in ${filePath}:`, parseError.message);
                        }                        
                    })
                }
            })
        }
        
        scan(srcFolder)

        const docTemplate = readFileSync(idxFolder+'doc/index.html', 'utf8')
        const docHtml = docTemplate.replace('{data}', JSON.stringify(data))

        writeFileSync(docFolder + 'data.json', JSON.stringify(data))
        writeFileSync(docFolder + 'index.html', docHtml)
        
        console.log(`✅ Documentation built with ${data.length}/${scanned} entries`);
        done()
    } catch (error) {
        console.error('❌ Error building documentation:', error.message);
        done(error);
    }
}

// create named task
function run(name, fn) {
    Object.defineProperty(fn, 'name', { value: name });
    return fn;
}

function createPlatformBuild(platform) {
    return series(
        run(` - merge`, buildAppJs),
        run(` - /public/ ⇒ ${platform}`, () => copyPublicFolder(platform)), 
        run(` - uglify`, minifyAppJs), 
        run(` - app.min.js ⇒ ${platform}`, () => copyAppMiniJs(platform)), 
        run(` - /index/ ⇒ ${platform}`, () => copyIndexFolder(platform))
    );
}

// debug
export const debug          = parallel(enableDebugMode, watch_changes, browser_syncup);

// build documentation
export const doc            = series(copyDocFolder, buildDocumentation)

// build packages
export const build_plugins   = series(buildPluginStyles, buildPlugins);
export const build_webos     = createPlatformBuild('webos'); //series(sync_webos, uglify_task, publicWebOs, indexWebOs);
export const build_tizen     = createPlatformBuild('tizen'); //series(sync_tizen, uglify_task, publicTizen, indexTizen);
export const build_github    = series(createPlatformBuild('github'), buildManifest); //series(merge, sync_github, uglify_task, publicGithub, buildManifest, indexGitHub);
export const build_web       = series(buildAppJs, build_plugins, buildAppStyles, copyLanguages, run(' - /public/ ⇒ web', () => copyPublicFolder('web')), copyAppJsToWeb, copyPlugins);

export default debug