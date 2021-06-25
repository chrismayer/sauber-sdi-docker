/*
 * Script to publish SAUBER rasters as granules into the SAUBER SDI.
 *
 * @author C. Mayer, meggsimum
 */
import fetch from 'node-fetch';
import GeoServerRestClient from 'geoserver-node-client';
import {framedBigLogging, framedMediumLogging} from './js-utils/logging.js';
import dockerSecret from './js-utils/docker-secrets.js';
import fs from 'fs';
import {exec} from 'child_process';

const verbose = process.env.GSPUB_VERBOSE;

const postgRestUrl = process.env.GSPUB_PG_REST_URL || 'http://postgrest_raster_publisher:3000';
const postgRestUser = process.env.GSPUB_PG_REST_USER;
const postgRestPw = dockerSecret.read('postgrest_password') || process.env.GSPUB_PG_REST_PW;

verboseLogging('PostgREST URL: ', postgRestUrl);
verboseLogging('PostgREST User:', postgRestUser);
verboseLogging('PostgREST PW:  ', postgRestPw);

const rasterMetaTable = process.env.GSPUB_RASTER_META_TBL || 'raster_metadata';

const geoserverUrl = process.env.GSPUB_GS_REST_URL || 'http://geoserver:8080/geoserver/rest/';
const geoserverUser = dockerSecret.read('geoserver_user') || process.env.GSPUB_GS_REST_USER;
const geoserverPw = dockerSecret.read('geoserver_password') || process.env.GSPUB_GS_REST_PW;

verboseLogging('GeoServer REST URL: ', geoserverUrl);
verboseLogging('GeoServer REST User:', geoserverUser);
verboseLogging('GeoServer REST PW:  ', geoserverPw);

// database password
const pgPassword = dockerSecret.read('app_password') || process.env.GSINIT_PG_PW;

/**
 * Main process:
 *  - Queries all unpublished rasters from DB
 *  - Publishes the unpublished rasters in GeoServer mosaic
 *  - Marks the raster as published in the DB
 */
async function publishRasters() {
  framedBigLogging('Start process publishing SAUBER rasters to GeoServer...');

  // Query all unpublished rasters from DB
  const unpublishedRasters = await getUnpublishedRasters();
  // exit if raster metadata could not be loaded
  const noRasterUnpublished = !unpublishedRasters ||
    (Array.isArray(unpublishedRasters) &&
      unpublishedRasters.length === 0
    );
  if (noRasterUnpublished) {
    framedMediumLogging('Could not get raster metadata - ABORT!');
    process.exit(1);
  }

  framedMediumLogging('Create CoverageStores if not existing');

  // check if given CoverageStores exists and create them if not
  await asyncForEach(unpublishedRasters, checkIfCoverageStoresExist);

  framedMediumLogging('Create time-enabled WMS layers if not existing');

  await asyncForEach(unpublishedRasters, createRasterTimeLayers);

  framedMediumLogging('Publish rasters');

  await asyncForEach(unpublishedRasters, async (rasterMetaInf) => {
    verboseLogging('Publish raster', rasterMetaInf.image_path);

    // TODO: remove ".then", because not needed in combination with "await"
    await addRasterToGeoServer(rasterMetaInf).then(async (success) => {
      if (success) {
        await markRastersPublished(rasterMetaInf);
      } else {
        console.warn('Could not add raster/granule "', rasterMetaInf.image_path ,'" to store', rasterMetaInf.coverage_store);
      }
      verboseLogging('-----------------------------------------------------\n');
    });
  });
}

/**
 * Checks if GeoServer has the CoverageStore given in the raster meta info.
 * If not it is created in GeoServer by its REST-API.
 *
 * @param {Object} rasterMetaInf Properties about a raster
 */
async function checkIfCoverageStoresExist(rasterMetaInf) {
  const ws = rasterMetaInf.workspace;
  const covStore = rasterMetaInf.coverage_store;

  verboseLogging('Checking', covStore, 'if it exists in GeoServer');

  const covStoreObj = await grc.datastores.getCoverageStore(ws, covStore);

  if (!covStoreObj) {
    console.info('CoverageStore', covStore, 'does not exist. Try to create it ...');

    ////////////////////////////////
    ///// indexer.properties ///////
    ////////////////////////////////
    // TODO: refactor process.cwd + dir
    const indexerFile = process.cwd() + '/gs-img-mosaic-tpl/indexer.properties.tpl';
    const indexerFileCopy = process.cwd() + '/gs-img-mosaic-tpl/indexer.properties';
    // copy indexer template so we can modify
    fs.copyFileSync(indexerFile, indexerFileCopy);
    console.info(`${indexerFile} was copied to ${indexerFileCopy}`);

    // matches the filename of the aboslute file path
    // /opt/raster_data/foo.tiff => foo.tiff
    const regex = /\/[^/]*?\.\S*/gm;
    const rasterFile = rasterMetaInf.image_path;
    // getting the file path only by substitution of filename with nothing
    const mosaicPath = rasterFile.replace(regex, '');

    // seth path to rasters in indexer.properties
    const indexingDirText = '\nIndexingDirectories=' + mosaicPath;
    fs.appendFileSync(indexerFileCopy, indexingDirText);

    // TODO: access DB to set properties_path

    ////////////////////////////////
    ///// datastore.properties /////
    ////////////////////////////////

    const dataStoreTemplateFile = process.cwd() + '/gs-img-mosaic-tpl/datastore.properties.tpl';
    const dataStoreFile = process.cwd() + '/gs-img-mosaic-tpl/datastore.properties';

    // TODO: needs to be tested
    console.log('... replacing dataStore file');
    const readData = fs.readFileSync(dataStoreTemplateFile, 'utf8');
    console.log({readData})

    const adaptedContent = readData.replace(/__DATABASE_PASSWORD__/g, pgPassword);
    console.log({adaptedContent})
    fs.writeFileSync(dataStoreFile, adaptedContent);
    console.log('... DONE Replacing datastore file');

    // zip image mosaic properties config files
    const fileToZip = [
      'gs-img-mosaic-tpl/indexer.properties',
      'gs-img-mosaic-tpl/datastore.properties',
      'gs-img-mosaic-tpl/timeregex.properties'
    ];
    const zipPath = '/tmp/init.zip';
    const zipOut = await execShellCommand('zip -j ' + zipPath + ' ' + fileToZip.join(' '));
    console.log(zipOut);

    // TODO ensure the zip is available in GeoServer container

    await grc.datastores.createImageMosaicStore(ws, covStore, zipPath);

    console.info('... CoverageStore', covStore, 'created');
  }
}

/**
 * Creates a time-enabled layer in the GeoServer for the given raster mosaic if
 * not existing by GeoServer REST-API.
 *
 * @param {Object} rasterMetaInf
 */
async function createRasterTimeLayers (rasterMetaInf) {
  const ws = rasterMetaInf.workspace;
  const covStore = rasterMetaInf.coverage_store;
  const srs = 'EPSG:3035'; //TODO check if defined in DB
  // per convention coverage store name is layer name and layer title
  const layerName = covStore;
  const nativeName = rasterMetaInf.properties_path;
  const layerTitle = covStore;

  verboseLogging(`Checking existence for layer ${ws}:${layerName} in coverage store ${covStore} (native name: ${nativeName})`);

  const layer = await grc.layers.get(covStore);

  if (!layer) {
    console.info(`Creating layer "${ws}:${layerName}" in store "${covStore}"`);
    // publishDbRaster (workspace, coverageStore, nativeName, name, title, srs, enabled)
    const layerCreated = await grc.layers.publishDbRaster(ws, covStore, nativeName, layerName, layerTitle, srs, true);
    verboseLogging(`Layer "${ws}:${layerName}" created successfully?`, layerCreated);

    console.info(`Enabling time for layer "${ws}:${layerName}"`);
    const timeEnabled = await grc.layers.enableTimeCoverage(ws, covStore, layerName, 'DISCRETE_INTERVAL', 3600000, 'MAXIMUM');
    verboseLogging(`Time dimension for layer "${ws}:${layerName}" successfully enabled?`, timeEnabled);

  } else {
    verboseLogging(`Layer "${ws}:${layerName}" already existing - Skip.`);
  }
}

/**
 * Returns all unpublished rasters from the raster meta info DB.
 *
 * @param {Object[]} publishedRasters
 */
async function getUnpublishedRasters() {
  verboseLogging('Load all unpublished rasters from raster meta info DB ...');

  // add trailing '/' if necessary
  const pgrstUrl = postgRestUrl.endsWith('/') ? postgRestUrl : postgRestUrl + '/';

  try {
    let url = pgrstUrl + rasterMetaTable;
    url += '?is_published=eq.0'; // filter for unpublished rasters
    verboseLogging('URL to load raster meta info:', url);
    // const auth = getPostgRestAuth();

    const response = await fetch(url, {
      // credentials: 'include',
      method: 'GET',
      headers: {
        // Authorization: 'Basic ' + auth
      }
    });

    if (response.status === 200) {
      const rasters = await response.json();

      console.info('Loaded', rasters.length, 'unpublished rasters from raster meta info DB');

      return rasters;
    } else {
      console.error('Got non HTTP 200 response (HTTP status code', response.status, ') for loading raster meta info');
      return false;
    }

  } catch (error) {
    return false;
  }
}

/**
 * Publishes the given raster in GeoServer to dedicated mosaic.
 *
 * @param {Object} rasterMetaInf
 */
async function addRasterToGeoServer(rasterMetaInf) {
  verboseLogging('Adding raster to GeoServer mosaic ...', rasterMetaInf.image_path);

  // TODO remove defaults
  const ws = rasterMetaInf.workspace || 'sauber-sdi';
  const covStore = rasterMetaInf.coverage_store || 'nrw_pm10_gm1h24h_mosaic';
  const imgMosaic = rasterMetaInf.image_mosaic || 'nrw_pm10_gm1h24h_mosaic';
  const rasterFile = rasterMetaInf.image_path;

  if (verbose) {
    const granulesBefore = await grc.imagemosaics.getGranules(ws, covStore, imgMosaic);
    if (granulesBefore && granulesBefore.features) {
      verboseLogging('Having', granulesBefore.features.length, 'granules before adding', rasterFile);
    }
  }

  // // add granule by GeoServer REST API
  const coverageToAdd = 'file://' + rasterFile;
  verboseLogging('Try to add Granule ...', coverageToAdd);
  const added = await grc.imagemosaics.addGranuleByServerFile(ws, covStore, coverageToAdd);
  verboseLogging('... Added granule by server file', added);

  if (verbose) {
    const granulesAfter = await grc.imagemosaics.getGranules(ws, covStore, imgMosaic);
    verboseLogging('Having', granulesAfter.features.length, 'granules after adding', rasterFile);
  }

  console.info('Added granule', rasterFile, 'in GeoServer mosaic', imgMosaic);

  return added;
}

/**
 * Marks the raster as published in the raster meta info DB.
 *
 * @param {Object} rasterMetaInf
 */
async function markRastersPublished(rasterMetaInf) {
  verboseLogging('Mark raster', rasterMetaInf.image_path ,'as published ...');

  // add trailing '/' if necessary
  const pgrstUrl = postgRestUrl.endsWith('/') ? postgRestUrl : postgRestUrl + '/';

  try {
    const rasterDbId = rasterMetaInf.idpk_image;
    const body = {
      "is_published": 1
    };
    const url = pgrstUrl + rasterMetaTable + '?idpk_image=eq.' + rasterDbId;

    // const auth = getPostgRestAuth();

    const response = await fetch(url, {
      // credentials: 'include',
      method: 'PATCH',
      headers: {
        'Content-type': 'application/json'
        // Authorization: 'Basic ' + auth
      },
      body: JSON.stringify(body)
    });

    verboseLogging('PATCH to raster meta info DB responded with code', response.status);

    if (!response.status === 200 && !response.status === 204) {
      const respText = await response.text();
      console.warn('Failed to mark raster as published in DB', respText);
      console.warn('It is very likely that your raster meta info DB is out of sync with GeoServer!');
    } else {
      console.info('Marked raster', rasterMetaInf.image_path ,'as published in DB');
    }

  } catch (error) {
    console.error(error);
    return false;
  }
}

/**
 * Helper to perform asynchronous forEach.
 * Found at https://codeburst.io/javascript-async-await-with-foreach-b6ba62bbf404
 *
 * @param {*[]} array
 * @param {Function} callback
 */
async function asyncForEach(array, callback) {
  for (let index = 0; index < array.length; index++) {
    await callback(array[index], index, array);
  }
}

/**
 * Executes a shell command and return it as a Promise.
 * Kudos to https://ali-dev.medium.com/how-to-use-promise-with-exec-in-node-js-a39c4d7bbf77
 *
 * @param cmd {string}
 * @return {Promise<string>}
 */
function execShellCommand(cmd) {
  return new Promise((resolve, reject) => {
    exec(cmd, (error, stdout, stderr) => {
      if (error) {
        console.warn(error);
      }
      resolve(stdout? stdout : stderr);
    });
  });
}

/**
 * Returns the authentication header for PostgREST API.
 */
function getPostgRestAuth() {
  return Buffer.from(postgRestUser + ':' + postgRestPw).toString('base64');
}

/**
 *
 * @param {String} msg
 */
function exitWithErrMsg(msg) {
  framedMediumLogging(msg);
  process.exit(1);
}

function verboseLogging(msg) {
  if (verbose) {
    console.log.apply(console, arguments);
  }
}

// check if we can connect to GeoServer REST API
const grc = new GeoServerRestClient(geoserverUrl, geoserverUser, geoserverPw);
grc.exists().then(gsExists => {
  if (gsExists === true) {
    // start publishing process
    publishRasters();
  } else {
    exitWithErrMsg('Could not connect to GeoServer REST API - ABORT!');
  }
});
