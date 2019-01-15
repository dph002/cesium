define([
        '../Core/Cartesian2',
        '../Core/Cartesian3',
        '../Core/Cartesian4',
        '../Core/Cartographic',
        '../Core/Math',
        '../Core/Check',
        '../Core/Color',
        '../Core/Credit',
        '../Core/defaultValue',
        '../Core/defined',
        '../Core/defineProperties',
        '../Core/DeveloperError',
        '../Core/FeatureDetection',
        '../Core/GeographicProjection',
        '../Core/getAbsoluteUri',
        '../Core/Matrix4',
        '../Core/IntersectionTests',
        '../Core/Plane',
        '../Core/Ray',
        '../Core/Rectangle',
        '../Core/RectangleCollisionChecker',
        '../Core/TaskProcessor',
        '../Core/SerializedMapProjection',
        '../ThirdParty/when',
        './BitmapImageryProvider',
        './ImageryLayer',
        './SceneMode'
    ], function(
        Cartesian2,
        Cartesian3,
        Cartesian4,
        Cartographic,
        CesiumMath,
        Check,
        Color,
        Credit,
        defaultValue,
        defined,
        defineProperties,
        DeveloperError,
        FeatureDetection,
        GeographicProjection,
        getAbsoluteUri,
        Matrix4,
        IntersectionTests,
        Plane,
        Ray,
        Rectangle,
        RectangleCollisionChecker,
        TaskProcessor,
        SerializedMapProjection,
        when,
        BitmapImageryProvider,
        ImageryLayer,
        SceneMode) {
    'use strict';

    var insetWaitFrames = 3;
    /**
     * Manages imagery layers for asynchronous pixel-perfect imagery reprojection.
     *
     * @alias ImageryMosaic
     * @constructor
     *
     * @param {Object} options Object with the following properties:
     * @param {String[]} options.urls the url for the imagery sources.
     * // TODO: add optional parallel list of IDs for Z order and show/hide
     * @param {Rectangle[]} options.projectedRectangles The rectangles covered by the images in their source Spatial Reference Systems
     * @param {MapProjection[]} options.projections The map projections for each image.
     * @param {Credit|String} [options.credit] A credit for all the images, which is displayed on the canvas.
     * @param {Scene} options.scene The current Cesium scene.
     * @param {Number} [options.concurrency] The number of web workers across which the load should be distributed.
     * @param {Number} [options.imageCacheSize=100] Number of cached images to hold in memory at once
     */
    function ImageryMosaic(options, viewer) {
        if (!((FeatureDetection.isChrome() && FeatureDetection.chromeVersion()[0] >= 69) ||
            (FeatureDetection.isFirefox() && FeatureDetection.firefoxVersion()[0] >= 62))) {
            throw new DeveloperError('ImageryMosaic is only supported in Chrome 69+ and Firefox 62+.');
        }

        //>>includeStart('debug', pragmas.debug);
        Check.defined('options', options);
        Check.defined('options.urls', options.urls);
        Check.defined('options.projectedRectangles', options.projectedRectangles);
        Check.defined('options.projections', options.projections);
        Check.defined('options.scene', options.scene);
        //>>includeEnd('debug');

        var urls = options.urls;
        var projectedRectangles = options.projectedRectangles;
        var projections = options.projections;

        var imagesLength = urls.length;

        // Make URLs absolute, serialize projections, insert into collision checker for picking.
        var absoluteUrls = new Array(imagesLength);
        var serializedMapProjections = new Array(imagesLength);
        var rectangleCollisionChecker = new RectangleCollisionChecker(new GeographicProjection());
        var i;
        for (i = 0; i < imagesLength; i++) {
            var projection = projections[i];
            absoluteUrls[i] = getAbsoluteUri(urls[i]);
            serializedMapProjections[i] = new SerializedMapProjection(projection);

            var unprojectedRectangle = Rectangle.approximateCartographicExtents(projectedRectangles[i], projection);
            rectangleCollisionChecker.insert(i, unprojectedRectangle);
        }

        this._projectedRectangles = projectedRectangles;
        this._projections = projections;
        this._urls = absoluteUrls;
        this._rectangleCollisionChecker = rectangleCollisionChecker;

        var credit = options.credit;
        var scene = options.scene;

        if (typeof credit === 'string') {
            credit = new Credit(credit);
        }
        this._credit = credit;
        this._rectangle = new Rectangle();

        var concurrency = defaultValue(options.concurrency, Math.max(FeatureDetection.hardwareConcurrency - 1, 1));
        var initWebAssemblyPromises = [];
        var taskProcessors = new Array(concurrency);
        for (i = 0; i < concurrency; i++) {
            taskProcessors[i] = new TaskProcessor('createReprojectedImagery');
            var initwasm = taskProcessors[i].initWebAssemblyModule({
                modulePath : 'ThirdParty/Workers/stbi_decode.js',
                wasmBinaryFile : 'ThirdParty/stbi_decode.wasm'
            });
            initWebAssemblyPromises.push(initwasm.promise);
        }
        this._taskProcessors = taskProcessors;

        this._localRenderingBounds = new Rectangle();

        this._fullCoverageImageryLayer = undefined;
        this._localImageryLayer = undefined;
        this._reprojectionPromise = undefined;
        this._iteration = 0;

        this._freeze = false;

        this._scene = scene;

        this._waitedFrames = 0;

        this._entityCollection = viewer.entities;

        this._pickRectangles = [];
        this._boundsRectangle = undefined;
        this._debugShowBoundsRectangle = false;

        var that = this;

        var urlGroups = new Array(concurrency);
        var serializedProjectionGroups = new Array(concurrency);
        var projectedRectangleGroups = new Array(concurrency);

        for (i = 0; i < concurrency; i++) {
            urlGroups[i] = [];
            serializedProjectionGroups[i] = [];
            projectedRectangleGroups[i] = [];
        }

        for (i = 0; i < imagesLength; i++) {
            var index = i % concurrency;
            urlGroups[index].push(absoluteUrls[i]);
            serializedProjectionGroups[index].push(serializedMapProjections[i]);
            projectedRectangleGroups[index].push(projectedRectangles[i]);
        }

        this.readyPromise = when.all(initWebAssemblyPromises)
            .then(function() {
                var initializationPromises = [];
                for (i = 0; i < concurrency; i++) {
                    initializationPromises.push(taskProcessors[i].scheduleTask({
                        initialize : true,
                        urls : urlGroups[i],
                        serializedMapProjections : serializedProjectionGroups[i],
                        projectedRectangles : projectedRectangleGroups[i],
                        imageCacheSize : defaultValue(options.imageCacheSize, 100),
                        id : i
                    }));
                }
                return when.all(initializationPromises);
            })
            .then(function(rectangles) {
                // Merge rectangles
                var thatRectangle = Rectangle.clone(rectangles[0], that._rectangle);
                for (var i = 1; i < concurrency; i++) {
                    var rectangle = rectangles[i];
                    thatRectangle.east = Math.max(thatRectangle.east, rectangle.east);
                    thatRectangle.west = Math.min(thatRectangle.west, rectangle.west);
                    thatRectangle.north = Math.max(thatRectangle.north, rectangle.north);
                    thatRectangle.south = Math.min(thatRectangle.south, rectangle.south);
                }
                that._rectangle = thatRectangle;

                // Create the full-coverage version
                return requestProjection(that, 1024, 1024, thatRectangle, that._iteration);
            })
            .then(function(result) {
                var bitmapImageryProvider = new BitmapImageryProvider({
                    bitmap : result.bitmap,
                    rectangle : that._rectangle,
                    credit : that._credit
                });
                var imageryLayer = new ImageryLayer(bitmapImageryProvider, {rectangle : bitmapImageryProvider.rectangle});

                that._fullCoverageImageryLayer = imageryLayer;
                scene.imageryLayers.add(imageryLayer);
            })
            .then(function() {
                // Listen for camera changes
                scene.camera.moveEnd.addEventListener(function() {
                    if (that._freeze) {
                        return;
                    }
                    that.refresh(scene);
                });

                scene.postRender.addEventListener(function() {
                    if (that._waitedFrames < insetWaitFrames) {
                        that._waitedFrames++;
                        if (that._waitedFrames === insetWaitFrames) {
                            that._fullCoverageImageryLayer.cutoutRectangle = that._localRenderingBounds;
                        }
                    }
                });

                // Refresh now that we're loaded
                that.refresh(scene);
            })
            .otherwise(function(error) {
                console.log(error);
            });
    }

    defineProperties(ImageryMosaic.prototype, {
        freeze : {
            get: function() {
                return this._freeze;
            },
            set: function(value) {
                this._freeze = value;
                if (value === false) {
                    this.refresh(this._scene);
                }
            }
        },
        debugShowBoundsRectangle : {
            get: function() {
                return this._debugShowBoundsRectangle;
            },
            set: function(value) {
                if (value) {
                    this._debugShowBoundsRectangle = true;
                    if (defined(this._boundsRectangle)) {
                        this._boundsRectangle.show = true;
                    }
                } else {
                    this._debugShowBoundsRectangle = false;
                    if (defined(this._boundsRectangle)) {
                        this._boundsRectangle.show = false;
                    }
                }
            }
        }
    });

    var samplePoint3Scratch = new Cartesian3();
    var surfaceNormalScratch = new Cartesian3();
    var cvPositionScratch = new Cartesian3();
    var samplePointCartographicScratch = new Cartographic();
    var raycastPointScratch = new Cartesian2();
    var rayScratch = new Ray();
    var cvPlane = new Plane(Cartesian3.UNIT_X, 0.0);
    ImageryMosaic.prototype.refresh = function(scene) {
        // Compute an approximate geographic rectangle that we're rendering
        var quadtreePrimitive = scene.globe._surface;
        var quadtreeTilesToRender = quadtreePrimitive._tilesToRender;
        var quadtreeTilesToRenderLength = quadtreeTilesToRender.length;
        if (quadtreeTilesToRenderLength < 1) {
            return;
        }

        var renderingBounds = new Rectangle(); // Create new to avoid race condition with in-flight refreshes
        renderingBounds.west = Number.POSITIVE_INFINITY;
        renderingBounds.east = Number.NEGATIVE_INFINITY;
        renderingBounds.south = Number.POSITIVE_INFINITY;
        renderingBounds.north = Number.NEGATIVE_INFINITY;

        // Cast rays from the camera in a screenspace grid against plane or ellipsoid to determine the rectangle
        var sqrtRayPoints = 10;
        var camera = scene.camera;
        var drawingBufferWidth = scene.drawingBufferWidth;
        var drawingBufferHeight = scene.drawingBufferHeight;
        var gridWidthInterval = drawingBufferWidth / (sqrtRayPoints - 1);
        var gridHeightInterval = drawingBufferHeight / (sqrtRayPoints - 1);
        var raycastPoint = raycastPointScratch;

        var ellipsoid = scene.globe.ellipsoid;
        var mapProjection = scene.mapProjection;
        var viewProjection = scene.context.uniformState.viewProjection;
        var cameraPosition = scene.camera.positionWC;

        for (var y = 0; y < sqrtRayPoints; y++) {
            for (var x = 0; x < sqrtRayPoints; x++) {
                raycastPoint.x = x * gridWidthInterval;
                raycastPoint.y = y * gridHeightInterval;

                var gridRay = camera.getPickRay(raycastPoint, rayScratch);
                var intersectionCartographic;
                var samplePoint3 = samplePoint3Scratch;
                var surfaceNormal = surfaceNormalScratch;
                if (scene.mode === SceneMode.SCENE3D) {
                    var interval = IntersectionTests.rayEllipsoid(gridRay, ellipsoid);
                    if (!defined(interval)) {
                        continue;
                    }
                    Ray.getPoint(gridRay, interval.start, samplePoint3);
                    intersectionCartographic = ellipsoid.cartesianToCartographic(samplePoint3, samplePointCartographicScratch);
                    ellipsoid.geodeticSurfaceNormal(samplePoint3, surfaceNormal);
                } else {
                    IntersectionTests.rayPlane(gridRay, cvPlane, samplePoint3);
                    if (!defined(samplePoint3)) {
                        continue;
                    }
                    var cvPosition = cvPositionScratch;
                    cvPosition.x = samplePoint3.y;
                    cvPosition.y = samplePoint3.z;
                    cvPosition.z = samplePoint3.x;

                    intersectionCartographic = mapProjection.unproject(cvPosition, samplePointCartographicScratch);
                    surfaceNormal = Cartesian3.UNIT_X;
                }

                if (pointVisible(samplePoint3, viewProjection, cameraPosition, surfaceNormal)) {
                    renderingBounds.west = Math.min(renderingBounds.west, intersectionCartographic.longitude);
                    renderingBounds.east = Math.max(renderingBounds.east, intersectionCartographic.longitude);
                    renderingBounds.south = Math.min(renderingBounds.south, intersectionCartographic.latitude);
                    renderingBounds.north = Math.max(renderingBounds.north, intersectionCartographic.latitude);
                }
            }
        }

        var imageryBounds = this._rectangle;
        renderingBounds.west = Math.max(renderingBounds.west, imageryBounds.west);
        renderingBounds.east = Math.min(renderingBounds.east, imageryBounds.east);
        renderingBounds.south = Math.max(renderingBounds.south, imageryBounds.south);
        renderingBounds.north = Math.min(renderingBounds.north, imageryBounds.north);

        // Don't bother projecting if the view is out-of-bounds
        if (renderingBounds.north <= renderingBounds.south || renderingBounds.east <= renderingBounds.west) {
            return;
        }

        // Don't bother projecting if we're looking at the whole thing
        if (Rectangle.equals(renderingBounds, this._rectangle)) {
            return;
        }

        // Don't bother projecting if bounds haven't changed
        if (defined(this._localImageryLayer) && Rectangle.equals(renderingBounds, this._localRenderingBounds)) {
            return;
        }

        // render bounds debug
        if (defined(this._boundsRectangle)) {
            this._entityCollection.remove(this._boundsRectangle);
        }
        this._boundsRectangle = this._entityCollection.add({
            name : 'cutout',
            rectangle : {
                coordinates : renderingBounds,
                material : Color.WHITE.withAlpha(0.0),
                height : 10.0,
                outline : true,
                outlineWidth : 4.0,
                outlineColor : Color.WHITE
            },
            show : this._debugShowBoundsRectangle
        });

        this._iteration++;
        var that = this;
        requestProjection(this, 1024, 1024, renderingBounds, this._iteration)
            .then(function(result) {
                if (result.iteration !== that._iteration) {
                    // don't update imagery
                    return;
                }

                var reprojectedBitmap = result.bitmap;
                var bitmapImageryProvider = new BitmapImageryProvider({
                    bitmap : reprojectedBitmap,
                    rectangle : renderingBounds,
                    credit : that._credit
                });

                var newLocalImageryLayer = new ImageryLayer(bitmapImageryProvider, {rectangle : bitmapImageryProvider.rectangle});
                scene.imageryLayers.add(newLocalImageryLayer);

                if (defined(that._localImageryLayer)) {
                    scene.imageryLayers.remove(that._localImageryLayer);
                }

                that._localImageryLayer = newLocalImageryLayer;
                that._localRenderingBounds = Rectangle.clone(renderingBounds, that._localRenderingBounds);
                that._fullCoverageImageryLayer.cutoutRectangle = undefined;
                that._waitedFrames = 0;
            })
            .otherwise(function(e) {
                console.log(e); // TODO: handle or throw?
            });
    };

    var samplePointVec4Scratch = new Cartesian4();
    var cameraDirectionScratch = new Cartesian3();
    var maxCosineAngle = CesiumMath.toRadians(80);
    function pointVisible(samplePoint3, viewProjection, cameraPosition, surfaceNormal) {
        var samplePoint = samplePointVec4Scratch;
        samplePoint.x = samplePoint3.x;
        samplePoint.y = samplePoint3.y;
        samplePoint.z = samplePoint3.z;
        samplePoint.w = 1.0;

        Matrix4.multiplyByVector(viewProjection, samplePoint, samplePoint);
        var x = samplePoint.x / samplePoint.w;
        var y = samplePoint.y / samplePoint.w;
        var z = samplePoint.z / samplePoint.w;

        if (x < -1.0 || 1.0 < x || y < -1.0 || 1.0 < y || z < -1.0 || 1.0 < z) {
            return false;
        }

        var cameraDirection = Cartesian3.subtract(cameraPosition, samplePoint3, cameraDirectionScratch);
        Cartesian3.normalize(cameraDirection, cameraDirection);
        var cameraAngle = Math.acos(Cartesian3.dot(cameraDirection, surfaceNormal));

        return cameraAngle < maxCosineAngle; // TODO: do we need the acos here? something tells me no...
    }

    function requestProjection(workerClass, width, height, rectangle, iteration) {
        var taskProcessors = workerClass._taskProcessors;
        var concurrency = taskProcessors.length;
        var promises = new Array(concurrency);
        for (var i = 0; i < concurrency; i++) {
            promises[i] = taskProcessors[i].scheduleTask({
                reproject : true,
                width : width,
                height : height,
                rectangle : rectangle,
                iteration : iteration
            });
        }
        return when.all(promises)
            .then(function(results) {
                // check if the result is from an earlier iteration and should be ignored
                if (results[0].iteration !== workerClass._iteration) {
                    return results[0];
                }

                // alpha over
                var targetData = results[0].bitmap.data;
                var pixelCount = width * height;
                for (var i = 1; i < concurrency; i++) {
                    var portionData = results[i].bitmap.data;
                    for (var j = 0; j < pixelCount; j++) {
                        var index = j * 4;
                        var alpha = portionData[index + 3];
                        if (alpha > 0) {
                            targetData[index] = portionData[index];
                            targetData[index + 1] = portionData[index + 1];
                            targetData[index + 2] = portionData[index + 2];
                            targetData[index + 3] = alpha;
                        }
                    }
                }

                return results[0];
            });
    }

    var pickRectangleScratch = new Rectangle();
    var projectedCartesianScratch = new Cartesian3();
    var projectedCartographicScratch = new Cartographic();
    /**
     *
     * @param {Cartographic} cartographic Location at which to pick
     * @returns {String[]} A list of urls for picked images.
     */
    ImageryMosaic.prototype.pickCartographic = function(cartographic) {
        var pickRectangle = pickRectangleScratch;
        pickRectangle.west = pickRectangle.east = cartographic.longitude;
        pickRectangle.north = pickRectangle.south = cartographic.latitude;

        var candidateIndices = this._rectangleCollisionChecker.search(pickRectangle);
        var candidatesLength = candidateIndices.length;

        var projections = this._projections;
        var projectedRectangles = this._projectedRectangles;
        var urls = this._urls;

        // debug stuff
        var entityCollection = this._entityCollection;
        var pickRectangles = this._pickRectangles;
        var pickRectanglesLength = pickRectangles.length;
        for (var j = 0; j < pickRectanglesLength; j++) {
            entityCollection.remove(pickRectangles[j]);
        }

        pickRectangles = this._pickRectangles = [];

        var pickedUrls = [];
        for (var i = 0; i < candidatesLength; i++) {
            var candidateIndex = candidateIndices[i];
            var projection = projections[candidateIndex];
            var projectedRectangle = projectedRectangles[candidateIndex];

            var projectedPickPosition = projection.project(cartographic, projectedCartesianScratch);
            var projectedCartographic = projectedCartographicScratch;
            projectedCartographic.longitude = projectedPickPosition.x;
            projectedCartographic.latitude = projectedPickPosition.y;

            if (Rectangle.contains(projectedRectangle, projectedCartographic)) {
                pickedUrls.push(urls[candidateIndex]);

                // debug: generate a bounding rectangle entity
                pickRectangles.push(entityCollection.add({
                    name : urls[candidateIndex],
                    polygon : {
                        hierarchy : getHierarchy(projection, projectedRectangle),
                        material : Color.GREEN.withAlpha(0.0),
                        height : 10.0,
                        outline : true,
                        outlineWidth : 4.0,
                        outlineColor : Color.GREEN
                    }
                }));
            }
        }

        return pickedUrls;
    };

    function getHierarchy(projection, projectedRectangle) {
        var unprojectedNorthWest = projection.unproject(new Cartesian3(projectedRectangle.west, projectedRectangle.north));
        var unprojectedNorthEast = projection.unproject(new Cartesian3(projectedRectangle.east, projectedRectangle.north));
        var unprojectedSouthWest = projection.unproject(new Cartesian3(projectedRectangle.west, projectedRectangle.south));
        var unprojectedSouthEast = projection.unproject(new Cartesian3(projectedRectangle.east, projectedRectangle.south));

        return Cartesian3.fromRadiansArray([
            unprojectedNorthWest.longitude, unprojectedNorthWest.latitude,
            unprojectedNorthEast.longitude, unprojectedNorthEast.latitude,
            unprojectedSouthEast.longitude, unprojectedSouthEast.latitude,
            unprojectedSouthWest.longitude, unprojectedSouthWest.latitude
        ]);
    }

    ImageryMosaic._getHierarchy = getHierarchy;

    return ImageryMosaic;
});
