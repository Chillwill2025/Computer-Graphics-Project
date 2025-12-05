"use strict";

var canvas, gl;
var program, programLines, programStars;
var vBuffer, nBuffer, tBuffer, lineBuffer, starBuffer;
var projectionMatrix, viewMatrix;
var lastTime = 0;
var running = true;
var globalSpeed = 1.0;
// Debug: when true, render bodies using their base color (no lighting)
var debugNoLighting = false;
// Orbit camera state
var camRadius = 30.0;
var camAzimuth = 0.0; // degrees
var camElevation = 20.0; // degrees
var camTarget = vec3(0, 0, 0); // camera look-at target
var trackedBody = null; // body to follow with camera
var defaultCamRadius = 30.0;
var defaultCamAzimuth = 0.0;
var defaultCamElevation = 20.0;

// Mouse interaction
var isDragging = false;
var lastMouseX = 0;
var lastMouseY = 0;

function clamp(v, a, b){ return Math.max(a, Math.min(b, v)); }

function findBodyByName(name, root) {
    if (root.name === name) return root;
    for (var i = 0; i < root.children.length; i++) {
        var found = findBodyByName(name, root.children[i]);
        if (found) return found;
    }
    return null;
}

function Body(opts){
    this.name = opts.name || "";
    this.radius = opts.radius || 0.5;
    this.orbitRadius = opts.orbitRadius || 0.0;
    this.orbitPeriod = opts.orbitPeriod || 0.0; // seconds
    this.inclination = opts.inclination || 0.0; // degrees
    this.phase = opts.phase || 0.0; // radians
    this.rotationSpeed = opts.rotationSpeed || 0.0; // deg/sec
    this.color = opts.color || [1,1,1,1];
    this.emissive = opts.emissive || false;
    this.parent = opts.parent || null;
    this.children = [];
    this.trail = opts.trail || null; // reference to trail array

    this.angle = this.phase; // radians
    this.selfAngle = 0.0; // degrees
}

Body.prototype.addChild = function(child){ child.parent = this; this.children.push(child); };

Body.prototype.update = function(dt){
    if(this.orbitPeriod > 0.0001){
        var angularSpeed = (2.0*Math.PI) / this.orbitPeriod; // rad/sec
        this.angle += angularSpeed * dt * globalSpeed;
    }
    this.selfAngle += this.rotationSpeed * dt * globalSpeed;
    // Record trail position if this body has a trail array
    if(this.trail){
        var world = this.worldMatrix();
        var p4 = mult(world, vec4(0,0,0,1));
        var p = [p4[0], p4[1], p4[2]];
        var last = trailLastPos.get(this.trail);
        if(last){
            var dx = p[0]-last[0], dy = p[1]-last[1], dz = p[2]-last[2];
            var d = Math.sqrt(dx*dx+dy*dy+dz*dz);
            if(d > trailMaxDistance){
                var steps = Math.floor(d / trailMaxDistance);
                for(var s=1; s<=steps; s++){
                    var t = s / (steps + 1);
                    var ix = last[0] + dx * t;
                    var iy = last[1] + dy * t;
                    var iz = last[2] + dz * t;
                    this.trail.push(vec4(ix, iy, iz, 1.0));
                    if(this.trail.length > maxTrailLength) this.trail.shift();
                }
            }
        }
        this.trail.push(vec4(p[0], p[1], p[2], 1.0));
        if(this.trail.length > maxTrailLength) this.trail.shift();
        trailLastPos.set(this.trail, p);
    }
    for(var i=0;i<this.children.length;i++) this.children[i].update(dt);
}

Body.prototype.worldMatrix = function(){
    // compute local transform
    var x = this.orbitRadius * Math.cos(this.angle);
    var z = this.orbitRadius * Math.sin(this.angle);
    var orbitTrans = translate(x, 0, z);
    var incl = rotate(this.inclination, vec3(1,0,0));
    var spin = rotate(this.selfAngle, vec3(0,1,0));
    var scaleM = scale(this.radius, this.radius, this.radius);

    var local = mult(orbitTrans, mult(incl, mult(spin, scaleM)));
    if(this.parent) return mult(this.parent.worldMatrix(), local);
    return local;
}

// Scene objects
var bodies = [];
var sphereMeshCount = 0;
// Trails for all bodies
var sunTrail = [];
var sun2Trail = [];
var planetTrail = [];
var planet2Trail = [];
var planet3Trail = [];
var planet4Trail = [];
var planet5Trail = [];
var moonTrail = [];
var planetATrail = [];
var planetBTrail = [];
var planetCTrail = [];
var maxTrailLength = 750; // 3/5 of 1250
// Trail spacing control: ensure points are no farther apart than this distance
var trailMaxDistance = 0.15; // units between consecutive trail points
var trailLastPos = new Map(); // map trail array to last position

window.onload = function init(){
    canvas = document.getElementById("gl-canvas");
    gl = canvas.getContext('webgl2');
    if(!gl) { alert("WebGL2 not available"); return; }

    gl.viewport(0,0,canvas.width, canvas.height);
    gl.enable(gl.DEPTH_TEST);
    gl.clearColor(0.0, 0.0, 0.0, 1.0);

    program = initShaders(gl, "vertex-shader", "fragment-shader");
    programLines = initShaders(gl, "vertex-shader-lines", "fragment-shader-lines");
    programStars = initShaders(gl, "vertex-shader-stars", "fragment-shader-stars");
    
    // Create starfield quad buffer (NDC coordinates: -1 to 1)
    var quadVertices = [
        -1.0, -1.0,
         1.0, -1.0,
         1.0,  1.0,
        -1.0, -1.0,
         1.0,  1.0,
        -1.0,  1.0
    ];
    starBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, starBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(quadVertices), gl.STATIC_DRAW);

    // create shared sphere mesh
    var s = sphere(3);
    var positions = s.TriangleVertices;
    var normals = s.TriangleNormals;
    var texcoords = s.TextureCoordinates;
    sphereMeshCount = positions.length;

    vBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, flatten(positions), gl.STATIC_DRAW);

    nBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, nBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, flatten(normals), gl.STATIC_DRAW);

    // texcoord buffer
    tBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, tBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, flatten(texcoords), gl.STATIC_DRAW);

    // line buffer reused for orbit drawing
    lineBuffer = gl.createBuffer();

    // set up scene bodies: Sun, planet, moon
    // Place Sun on shared orbit path (same as Sun2) at the same point
    var sun = new Body({
        name:'Sun',
        radius:3,
        color:[1.0,0.9,0.2,1.0],
        emissive:true,
        rotationSpeed:6,
        orbitRadius:30.0,
        orbitPeriod:60.0,
        phase:0.0,
        inclination:30.0,
        trail:sunTrail
    });

    var planet = new Body({name:'Planet', radius:0.4, orbitRadius:4.0, orbitPeriod:8.0, rotationSpeed:60, color:[0.2,0.6,1.0,1.0], trail:planetTrail});
    var planet2 = new Body({name:'Planet2', radius:0.28, orbitRadius:6.5, orbitPeriod:14.0, rotationSpeed:48, color:[0.8,0.5,0.2,1.0], trail:planet2Trail});

    // additional planets orbiting the Sun
    var planet3 = new Body({name:'Planet3', radius:0.22, orbitRadius:9.5, orbitPeriod:20.0, rotationSpeed:30, color:[0.6,0.9,0.3,1.0], trail:planet3Trail});
    var planet4 = new Body({name:'Planet4', radius:0.5, orbitRadius:11.8, orbitPeriod:28.0, rotationSpeed:20, color:[0.9,0.6,0.2,1.0], trail:planet4Trail});
    var planet5 = new Body({name:'Planet5', radius:0.36, orbitRadius:14.0, orbitPeriod:40.0, rotationSpeed:18, color:[0.6,0.6,0.9,1.0], trail:planet5Trail});

    var moon = new Body({name:'Moon', radius:0.12, orbitRadius:2.0, orbitPeriod:2.6, rotationSpeed:120, color:[0.8,0.8,0.85,1.0], trail:moonTrail});

    sun.addChild(planet);
    planet.addChild(moon);
    sun.addChild(planet2);
    sun.addChild(planet3);
    sun.addChild(planet4);
    sun.addChild(planet5);

    bodies.push(sun);

    // Second solar system sun on the same orbit path and point as Sun
    var sun2 = new Body({
        name:'Sun2',
        radius:2,
        color:[0.9,0.3,0.9,1.0],
        emissive:true,
        rotationSpeed:8,
        orbitRadius:30.0,
        orbitPeriod:60.0,
        phase: Math.PI,
        inclination:30.0,
        trail:sun2Trail
    });
    
    var planetA = new Body({name:'PlanetA', radius:0.35, orbitRadius:3.0, orbitPeriod:6.0, rotationSpeed:50, color:[0.9,0.2,0.5,1.0], inclination:50.0, trail:planetATrail});
    var planetB = new Body({name:'PlanetB', radius:0.25, orbitRadius:5.0, orbitPeriod:10.0, rotationSpeed:40, color:[0.3,0.9,0.9,1.0], inclination:50.0, trail:planetBTrail});
    var planetC = new Body({name:'PlanetC', radius:0.30, orbitRadius:7.5, orbitPeriod:15.0, rotationSpeed:35, color:[0.9,0.9,0.3,1.0], inclination:50.0, trail:planetCTrail});

    sun2.addChild(planetA);
    sun2.addChild(planetB);
    sun2.addChild(planetC);

    bodies.push(sun2);

    // set up camera/projection (see farther with larger far plane)
    var aspect = canvas.width / canvas.height;
    projectionMatrix = perspective(45, aspect, 0.1, 500.0);

    // attach input handlers for camera control
    canvas.addEventListener('mousedown', function(e){
        isDragging = true;
        lastMouseX = e.clientX;
        lastMouseY = e.clientY;
    });
    window.addEventListener('mousemove', function(e){
        if(!isDragging) return;
        var dx = e.clientX - lastMouseX;
        var dy = e.clientY - lastMouseY;
        lastMouseX = e.clientX; lastMouseY = e.clientY;
        // adjust sensitivity
        camAzimuth += dx * 0.25;
        camElevation += dy * 0.25;
        camElevation = clamp(camElevation, -89.9, 89.9);
    });
    window.addEventListener('mouseup', function(e){ isDragging = false; });
    // bracket key zoom
    window.addEventListener('keydown', function(e){
        if (e.key === '[') {
            camRadius = clamp(camRadius * 0.92, 2.0, 200.0);
        } else if (e.key === ']') {
            camRadius = clamp(camRadius * 1.08, 2.0, 200.0);
        } else if (e.key === 'l' || e.key === 'L') {
            // toggle debug no-light mode
            debugNoLighting = !debugNoLighting;
            console.log('debugNoLighting =', debugNoLighting);
        }
    });
    // resize handler
    window.addEventListener('resize', function(){
        canvas.width = canvas.clientWidth;
        canvas.height = canvas.clientHeight;
        gl.viewport(0,0,canvas.width, canvas.height);
        var a = canvas.width / canvas.height;
        projectionMatrix = perspective(45, a, 0.1, 500.0);
        gl.useProgram(program);
        gl.uniformMatrix4fv(gl.getUniformLocation(program, "projectionMatrix"), false, flatten(projectionMatrix));
        gl.useProgram(programLines);
        gl.uniformMatrix4fv(gl.getUniformLocation(programLines, "projectionMatrix"), false, flatten(projectionMatrix));
    });

    // lighting material
    var myMaterial = goldMaterial();
    var myLight = light0();

    var ambientProduct = mult(myLight.lightAmbient, myMaterial.materialAmbient);
    var diffuseProduct = mult(myLight.lightDiffuse, myMaterial.materialDiffuse);
    var specularProduct = mult(myLight.lightSpecular, myMaterial.materialSpecular);

    gl.useProgram(program);
    gl.uniformMatrix4fv(gl.getUniformLocation(program, "projectionMatrix"), false, flatten(projectionMatrix));
    gl.uniform4fv(gl.getUniformLocation(program, "ambientProduct"), flatten(ambientProduct));
    gl.uniform4fv(gl.getUniformLocation(program, "diffuseProduct"), flatten(diffuseProduct));
    gl.uniform4fv(gl.getUniformLocation(program, "specularProduct"), flatten(specularProduct));
    gl.uniform4fv(gl.getUniformLocation(program, "lightPosition"), flatten(myLight.lightPosition));
    gl.uniform1f(gl.getUniformLocation(program, "shininess"), myMaterial.materialShininess);
    // create and bind a checkerboard texture and tell shader to use texture unit 0
    var checkerTex = checkerboardTexture(128, 8, 8);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, checkerTex);
    var texLoc = gl.getUniformLocation(program, "uTexture");
    if(texLoc) gl.uniform1i(texLoc, 0);
    var useTexLoc = gl.getUniformLocation(program, "uUseTexture");
    if(useTexLoc) gl.uniform1i(useTexLoc, 1);

    // wire up UI
    document.getElementById('toggle').onclick = function(){ running = !running; this.textContent = running ? 'Pause' : 'Resume'; };
    document.getElementById('speed').oninput = function(e){ globalSpeed = parseFloat(e.target.value); };

    // Camera control buttons
    function centerOnBody(bodyName) {
        var body = null;
        for (var i = 0; i < bodies.length; i++) {
            body = findBodyByName(bodyName, bodies[i]);
            if (body) break;
        }
        if (body) {
            trackedBody = body;
            camRadius = body.radius * 3.5; // zoom based on body size
            camAzimuth = 45.0;
            camElevation = 20.0;
        }
    }
    document.getElementById('cam-sun').onclick = function() { centerOnBody('Sun'); };
    document.getElementById('cam-planet').onclick = function() { centerOnBody('Planet'); };
    document.getElementById('cam-planet2').onclick = function() { centerOnBody('Planet2'); };
    document.getElementById('cam-planet3').onclick = function() { centerOnBody('Planet3'); };
    document.getElementById('cam-planet4').onclick = function() { centerOnBody('Planet4'); };
    document.getElementById('cam-planet5').onclick = function() { centerOnBody('Planet5'); };
    document.getElementById('cam-moon').onclick = function() { centerOnBody('Moon'); };
    document.getElementById('cam-sun2').onclick = function() { centerOnBody('Sun2'); };
    document.getElementById('cam-planetA').onclick = function() { centerOnBody('PlanetA'); };
    document.getElementById('cam-planetB').onclick = function() { centerOnBody('PlanetB'); };
    document.getElementById('cam-planetC').onclick = function() { centerOnBody('PlanetC'); };
    document.getElementById('cam-reset').onclick = function() {
        trackedBody = null;
        camTarget = vec3(0, 0, 0);
        camRadius = defaultCamRadius;
        camAzimuth = defaultCamAzimuth;
        camElevation = defaultCamElevation;
    };

    lastTime = performance.now();
    requestAnimationFrame(render);
}

function drawBody(body){
    var world = body.worldMatrix();
    var modelView = mult(viewMatrix, world);

    gl.useProgram(program);

    var positionLoc = gl.getAttribLocation(program, "aPosition");
    gl.bindBuffer(gl.ARRAY_BUFFER, vBuffer);
    gl.vertexAttribPointer(positionLoc, 4, gl.FLOAT, false, 0, 0);
    gl.enableVertexAttribArray(positionLoc);

    var normalLoc = gl.getAttribLocation(program, "aNormal");
    gl.bindBuffer(gl.ARRAY_BUFFER, nBuffer);
    gl.vertexAttribPointer(normalLoc, 3, gl.FLOAT, false, 0, 0);
    gl.enableVertexAttribArray(normalLoc);

    // texture coordinates attribute (if present in shader)
    var texLoc = gl.getAttribLocation(program, "aTexCoord");
    if(texLoc !== -1) {
        gl.bindBuffer(gl.ARRAY_BUFFER, tBuffer);
        gl.vertexAttribPointer(texLoc, 2, gl.FLOAT, false, 0, 0);
        gl.enableVertexAttribArray(texLoc);
    }

    gl.uniformMatrix4fv(gl.getUniformLocation(program, "modelViewMatrix"), false, flatten(modelView));
    var uColorLoc = gl.getUniformLocation(program, "uColor");
    if (uColorLoc) {
        gl.uniform4fv(uColorLoc, new Float32Array(body.color));
    }
    // allow debug override so we can view base colors without lighting
    var emissiveFlag = body.emissive || debugNoLighting;
    gl.uniform1i(gl.getUniformLocation(program, "uEmissive"), emissiveFlag ? 1 : 0);

    gl.drawArrays(gl.TRIANGLES, 0, sphereMeshCount);

    for(var i=0;i<body.children.length;i++) drawBody(body.children[i]);
}

function drawOrbit(body){
    if(body.orbitRadius > 0.001){
        var segments = 64;
        var pts = [];
        // For Sun/Sun2: don't draw their individual rings; draw one shared ring once (on Sun2)
        if (body.name === 'Sun') {
            // Skip drawing; shared ring will be drawn when processing Sun2
            // Continue to children
            for(var i=0;i<body.children.length;i++) drawOrbit(body.children[i]);
            return;
        }
        if (body.name === 'Sun2') {
            // Skip drawing center ring (invisible)
            // Continue to children
            for(var c=0;c<body.children.length;c++) drawOrbit(body.children[c]);
            return;
        }
        for(var i=0;i<segments;i++){
            var t = 2*Math.PI * (i/segments);
            var x = body.orbitRadius * Math.cos(t);
            var z = body.orbitRadius * Math.sin(t);
            // apply inclination
            var p = vec4(x, 0, z, 1.0);
            // rotate around X by inclination
            var inclMat = rotate(body.inclination, vec3(1,0,0));
            var p2 = mult(inclMat, p);
            // Place orbit ring: for children, relative to parent; for roots, center at body's current world position
            if(body.parent){
                var parentWorld = body.parent.worldMatrix();
                p2 = mult(parentWorld, p2);
            } else {
                // translate ring to body's current world position
                var bw = body.worldMatrix();
                var bpos = mult(bw, vec4(0,0,0,1));
                var toBody = translate(bpos[0], bpos[1], bpos[2]);
                p2 = mult(toBody, p2);
            }
            pts.push(p2);
        }
        gl.useProgram(programLines);
        var posLoc = gl.getAttribLocation(programLines, "aPosition");
        gl.bindBuffer(gl.ARRAY_BUFFER, lineBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, flatten(pts), gl.STATIC_DRAW);
        gl.vertexAttribPointer(posLoc, 4, gl.FLOAT, false, 0, 0);
        gl.enableVertexAttribArray(posLoc);

        var modelView = viewMatrix;
        gl.uniformMatrix4fv(gl.getUniformLocation(programLines, "modelViewMatrix"), false, flatten(modelView));
        gl.uniformMatrix4fv(gl.getUniformLocation(programLines, "projectionMatrix"), false, flatten(projectionMatrix));
        var lineColorLoc = gl.getUniformLocation(programLines, "uColor");
        if (lineColorLoc) {
            gl.uniform4fv(lineColorLoc, new Float32Array([0.6, 0.6, 0.6, 1.0]));
        }
        gl.drawArrays(gl.LINE_LOOP, 0, pts.length);
    }
    for(var i=0;i<body.children.length;i++) drawOrbit(body.children[i]);
}

function drawTrails(){
    gl.useProgram(programLines);
    var posLoc = gl.getAttribLocation(programLines, "aPosition");
    var lineColorLoc = gl.getUniformLocation(programLines, "uColor");
    
    gl.uniformMatrix4fv(gl.getUniformLocation(programLines, "modelViewMatrix"), false, flatten(viewMatrix));
    gl.uniformMatrix4fv(gl.getUniformLocation(programLines, "projectionMatrix"), false, flatten(projectionMatrix));
    
    // Helper function to draw a trail with specific color
    function drawTrail(trail, color){
        if(trail.length > 1){
            var segmentSize = 100;
            for(var start = 0; start < trail.length - 1; start += segmentSize){
                var end = Math.min(start + segmentSize + 1, trail.length);
                var segment = trail.slice(start, end);
                
                var age = trail.length - start - 1;
                var alpha = 1.0;
                if(age > 750){
                    var fadeRange = age - 750;
                    var maxFade = trail.length - 750;
                    alpha = Math.max(0.0, 1.0 - (fadeRange / maxFade));
                }
                
                gl.bindBuffer(gl.ARRAY_BUFFER, lineBuffer);
                gl.bufferData(gl.ARRAY_BUFFER, flatten(segment), gl.STATIC_DRAW);
                gl.vertexAttribPointer(posLoc, 4, gl.FLOAT, false, 0, 0);
                gl.enableVertexAttribArray(posLoc);
                
                if(lineColorLoc){
                    gl.uniform4fv(lineColorLoc, new Float32Array([color[0], color[1], color[2], alpha]));
                }
                gl.drawArrays(gl.LINE_STRIP, 0, segment.length);
            }
        }
    }
    
    // Draw all trails
    drawTrail(sunTrail, [1.0, 0.9, 0.2]);
    drawTrail(sun2Trail, [0.9, 0.3, 0.9]);
    drawTrail(planetTrail, [0.2, 0.6, 1.0]);
    drawTrail(planet2Trail, [0.8, 0.5, 0.2]);
    drawTrail(planet3Trail, [0.6, 0.9, 0.3]);
    drawTrail(planet4Trail, [0.9, 0.6, 0.2]);
    drawTrail(planet5Trail, [0.6, 0.6, 0.9]);
    drawTrail(moonTrail, [0.8, 0.8, 0.85]);
    drawTrail(planetATrail, [0.9, 0.2, 0.5]);
    drawTrail(planetBTrail, [0.3, 0.9, 0.9]);
    drawTrail(planetCTrail, [0.9, 0.9, 0.3]);
}

function render(now){
    var dt = (now - lastTime) / 1000.0; if(!running) dt = 0.0;
    lastTime = now;

    // update
    for(var i=0;i<bodies.length;i++) bodies[i].update(dt);

    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    
    // Render starfield background
    gl.useProgram(programStars);
    gl.bindBuffer(gl.ARRAY_BUFFER, starBuffer);
    var aPosStars = gl.getAttribLocation(programStars, "aPosition");
    gl.enableVertexAttribArray(aPosStars);
    gl.vertexAttribPointer(aPosStars, 2, gl.FLOAT, false, 0, 0);
    gl.disable(gl.DEPTH_TEST);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.enable(gl.DEPTH_TEST);

    // Update camera target to follow tracked body
    if (trackedBody) {
        var world = trackedBody.worldMatrix();
        var pos = mult(world, vec4(0, 0, 0, 1));
        camTarget = vec3(pos[0], pos[1], pos[2]);
    }

    // compute view matrix from orbit camera
    var elev = radians(camElevation);
    var azim = radians(camAzimuth);
    var ex = camTarget[0] + camRadius * Math.cos(elev) * Math.sin(azim);
    var ey = camTarget[1] + camRadius * Math.sin(elev);
    var ez = camTarget[2] + camRadius * Math.cos(elev) * Math.cos(azim);
    viewMatrix = lookAt(vec3(ex, ey, ez), camTarget, vec3(0,1,0));

    // draw orbits first
    for(var i=0;i<bodies.length;i++) drawOrbit(bodies[i]);

    // draw trails
    drawTrails();

    // draw bodies
    for(var i=0;i<bodies.length;i++) drawBody(bodies[i]);

    requestAnimationFrame(render);
}
