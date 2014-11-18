/*!
 *
 * Squarespace node server.
 *
 * - Cache conventions
 *      - block-*.html
 *      - query-*.json
 *      - page-*.json
 *      - page-*.html
 *      - api-*.json
 *
 */
var _ = require( "underscore" ),
    bodyParser = require( "body-parser" ),
    express = require( "express" ),
    path = require( "path" ),
    fs = require( "fs" ),
    fse = require( "fs-extra" ),
    slug = require( "slug" ),
    functions = require( "./lib/functions" ),
    sqsRequest = require( "./squarespace-request" ),
    sqsTemplate = require( "./squarespace-template" ),
    rProtocol = /^https:|^http:/g,
    rSlash = /^\/|\/$/g,
    rIco = /\.ico$/,
    rApi = /^\/api/,
    sqsUser = null,
    sqsTimeOfLogin = null,
    sqsTimeLoggedIn = 86400000,
    directories = {},
    config = null,
    expressApp = express(),


/**
 *
 * config.server = {
 *      siteurl,
 *      port,
 *      webroot,
 *      protocol,
 *      siteData
 *      cacheroot
 * };
 *
 * @method setServerConfig
 * @private
 *
 */
setServerConfig = function () {
    // @global - config
    config.server.siteurl = config.server.siteurl.replace( rSlash, "" );
    config.server.port = (config.server.port || 5050);
    config.server.webroot = process.cwd();
    config.server.protocol = config.server.siteurl.match( rProtocol )[ 0 ];
    config.server.siteData = {};

    if ( !config.server.cacheroot ) {
        config.server.cacheroot = path.join( config.server.webroot, ".sqs-cache" );

        if ( !fs.existsSync( config.server.cacheroot ) ) {
            fs.mkdirSync( config.server.cacheroot );
        }
    }

    // Set config on external modules
    sqsRequest.setConfig( config );
    sqsTemplate.setConfig( config );
},


/**
 *
 * @method setDirectories
 * @returns {object}
 * @private
 *
 */
setDirectories = function () {
    // @global - directories
    directories = {
        blocks: path.join( config.server.webroot, "blocks" ),
        collections: path.join( config.server.webroot, "collections" ),
        assets: path.join( config.server.webroot, "assets" ),
        pages: path.join( config.server.webroot, "pages" ),
        scripts: path.join( config.server.webroot, "scripts" ),
        styles: path.join( config.server.webroot, "styles" )
    };

    // Set directories on external modules
    sqsTemplate.setDirs( directories );
},


/**
 *
 * @method renderResponse
 * @param {object} appRequest The express request
 * @param {object} appResponse The express response
 * @private
 *
 */
renderResponse = function ( appRequest, appResponse ) {
    var cacheHtml = null,
        cacheJson = null,
        cacheName = null,
        slugged = slug( appRequest.params[ 0 ] ),
        reqSlug = ( slugged === "" ) ? "homepage" : slugged,
        url = (config.server.siteurl + appRequest.params[ 0 ]),
        qrs = {};

    cacheName = ("page-" + reqSlug);

    // Password?
    if ( config.server.password ) {
        qrs.password = config.server.password;
    }

    // Querystring?
    for ( var i in appRequest.query ) {
        qrs[ i ] = appRequest.query[ i ];

        // Unique cache file name including queries
        if ( i !== "format" && i !== "password" && i !== "nocache" ) {
            cacheName += ("-" + i + "--" + qrs[ i ]);
        }
    }

    cacheHtml = path.join( config.server.cacheroot, (cacheName + ".html") );
    cacheJson = path.join( config.server.cacheroot, (cacheName + ".json") );

    // JSON cache?
    if ( fs.existsSync( cacheJson ) ) {
        cacheJson = functions.readJson( path.join( config.server.cacheroot, (cacheName + ".json") ) );

    } else {
        cacheJson = null;
    }

    // HTML cache?
    if ( fs.existsSync( cacheHtml ) ) {
        cacheHtml = functions.readFile( path.join( config.server.cacheroot, (cacheName + ".html") ) );

    } else {
        cacheHtml = null;
    }

    // Nocache?
    if (  appRequest.query.nocache !== undefined ) {
        cacheJson = null;
        cacheHtml = null;

        functions.log( "Clearing request cache" );
    }

    // Cache?
    if ( cacheJson && cacheHtml && appRequest.query.format !== "json" ) {
        functions.log( "Loading request from cache" );

        sqsTemplate.renderTemplate( appRequest.params[ 0 ], qrs, cacheJson, cacheHtml, function ( tpl ) {
            appResponse.status( 200 ).send( tpl );
        });

        return;
    }

    // JSON?
    if ( appRequest.query.format === "json" ) {
        if ( cacheJson ) {
            functions.log( "Loading json from cache" );

            appResponse.status( 200 ).json( cacheJson );

        } else {
            sqsRequest.requestJson( url, qrs, function ( json ) {
                functions.writeJson( path.join( config.server.cacheroot, (cacheName + ".json") ), json );

                appResponse.status( 200 ).json( json );
            });
        }

    // Request page?
    } else {
        sqsRequest.requestJsonAndHtml( url, qrs, function ( data ) {
            functions.writeJson( path.join( config.server.cacheroot, (cacheName + ".json") ), data.json );
            functions.writeFile( path.join( config.server.cacheroot, (cacheName + ".html") ), functions.squashHtml( data.html ) );

            sqsTemplate.renderTemplate( appRequest.params[ 0 ], qrs, data.json, functions.squashHtml( data.html ), function ( tpl ) {
                appResponse.status( 200 ).send( tpl );
            });
        });
    }
},


/**
 *
 * @method onExpressRouterGET
 * @param {object} appRequest The express request
 * @param {object} appResponse The express response
 * @private
 *
 */
onExpressRouterGET = function ( appRequest, appResponse ) {
    // Exit clause...
    if ( rApi.test( appRequest.params[ 0 ] ) ) {
        appResponse.end();

        return;
    }

    // Maybe just do a redirect here?
    if ( rIco.test( appRequest.params[ 0 ] ) ) {
        appResponse.redirect( (config.server.siteurl + appRequest.params[ 0 ]) );

        return;
    }

    // Config
    if ( appRequest.params[ 0 ].replace( rSlash, "" ) === "config" ) {
        functions.log( "CONFIG - Author your content!" );

        appResponse.redirect( (config.server.siteurl + "/config/") );

        return;
    }

    // Logout
    if ( appRequest.params[ 0 ].replace( rSlash, "" ) === "logout" ) {
        functions.log( "AUTH - Logout of Squarespace!" );

        sqsUser = null;

        appResponse.redirect( "/" );

        return;
    }

    // Authentication
    if ( !sqsUser ) {
        functions.log( "AUTH - Login to Squarespace!" );

        appResponse.send( functions.readFile( path.join( __dirname, "tpl/login.html" ) ) );

        return;
    }

    // Login expired
    if ( (Date.now() - sqsTimeOfLogin) >= sqsTimeLoggedIn ) {
        functions.log( "AUTH EXPIRED - Logout of Squarespace!" );

        appResponse.redirect( "/logout" );

        return;
    }

    // Log URI
    functions.log( "GET - " + appRequest.params[ 0 ] );

    // Run the template compiler
    sqsTemplate.setSQSHeadersFooters();
    sqsTemplate.setHeaderFooter();
    sqsTemplate.compileCollections();
    sqsTemplate.compileRegions();
    sqsTemplate.replaceBlocks();
    sqsTemplate.replaceScripts();
    sqsTemplate.replaceSQSScripts();
    sqsTemplate.compileStylesheets();

    // Render the response
    renderResponse( appRequest, appResponse );
},


/**
 *
 * @method onExpressRouterPOST
 * @param {object} appRequest The express request
 * @param {object} appResponse The express response
 * @private
 *
 */
onExpressRouterPOST = function ( appRequest, appResponse ) {
    var data = {
            email: appRequest.body.email,
            password: appRequest.body.password
        };

    if ( !data.email || !data.password ) {
        functions.log( "AUTH - Email AND Password required." );

        appResponse.send( functions.readFile( path.join( __dirname, "tpl/login.html" ) ) );

        return;
    }

    // Keep user data in memory
    sqsUser = data;

    // Set user on external modules
    sqsRequest.setUser( sqsUser );
    sqsTemplate.setUser( sqsUser );

    // Login to site
    sqsRequest.loginPortal( function () {
        // Fetch site API data
        sqsRequest.fetchAPIData( function ( data ) {
            // Store the site data needed
            config.server.siteData = data;

            // Set config on external modules
            sqsRequest.setConfig( config );
            sqsTemplate.setConfig( config );

            // Store time of login
            sqsTimeOfLogin = Date.now();

            // End login post
            appResponse.json({
                success: true
            });
        });
    });
},


/**
 *
 * @method processArguments
 * @param {object} args The arguments array
 * @private
 *
 */
processArguments = function ( args ) {
    var data = functions.readJson( path.join( __dirname, "package.json" ) ),
        flags = {},
        commands = {};

    if ( !args || !args.length ) {
        console.log( "Squarespace Server" );
        console.log( "Version " + data.version );
        console.log();
        console.log( "Commands:" );
        console.log( "sqs buster       Delete local site cache" );
        console.log( "sqs server       Start the local server" );
        console.log();
        console.log( "Options:" );
        console.log( "sqs --version    Print package version" );
        console.log( "sqs --forever    Start server using forever-monitor" );
        console.log( "sqs --port=XXXX  Use the specified port" );
        console.log();
        console.log( "Examples:" );
        console.log( "sqs server --port=8000" );
        process.exit();
    }

    _.each( args, function ( arg ) {
        var rFlag = /^--/,
            split;

        if ( rFlag.test( arg ) ) {
            split = arg.split( "=" );
            flags[ split[ 0 ].replace( rFlag, "" ) ] = (split[ 1 ] || undefined);

        } else {
            commands[ arg ] = true;
        }
    });

    // Order of operations
    if ( flags.version ) {
        functions.log( data.version );
        process.exit();

    } else if ( commands.buster ) {
        fse.removeSync( path.join( config.server.cacheroot ) );
        functions.log( "Trashed your local .sqs-cache." );
        process.exit();

    } else if ( commands.server ) {
        if ( flags.port ) {
            config.server.port = flags.port;
        }

        startServer();
    }
},


/**
 *
 * @method startServer
 * @private
 *
 */
startServer = function () {
    // Create express application
    expressApp.use( express.static( config.server.webroot ) );
    expressApp.use( bodyParser.json() );
    expressApp.use( bodyParser.urlencoded( {extended: true} ) );
    expressApp.set( "port", config.server.port );
    expressApp.get( "*", onExpressRouterGET );
    expressApp.post( "/", onExpressRouterPOST );
    expressApp.listen( expressApp.get( "port" ) );

    // Log that the server is running
    functions.log( ("Running site on localhost:" + expressApp.get( "port" )) );
};


/******************************************************************************
 * @Export
*******************************************************************************/
module.exports = {
    /**
     *
     * @export
     * @public
     * -------
     * @method init
     * @param {object} conf The template.conf json
     * @param {object} args The command arguments
     *
     */
    init: function ( conf, args ) {
        // Create global config
        config = conf;

        // Create global config.server
        setServerConfig();

        // Create global directories
        setDirectories();

        // Handle arguments
        processArguments( args );
    }
};