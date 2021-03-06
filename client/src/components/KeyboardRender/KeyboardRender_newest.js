import React from "react";
import { mat4, vec3 } from "gl-matrix";

import "./KeyboardRender.scss";
import { fetchInfo, fetchCaseModel, fetchKeycapModel, fetchSwitchModel, fetchStabilizerModel } from "../../apiInteraction";
import { loadTexture, loadGLBuffers, setupShaders, rotateView, renderObject, renderSelection } from "../../utils/glFuncs";
import { ACCENTS, ALPHAS, SPECIAL_KEYCAP_IDENTIFIERS, SPECIAL_NUM_UNITS } from "../../utils/keyboardComponents";
// import { GLCanvas } from "./GLCanvas";s

const newProgramInfo = () => ({
    program: null,
    attribs: {},
    uniforms: {},
    buffers: {}
});


// lookup table for all non-1-unit-wide keys. Logically, SPECIAL_NUM_UNITS[key] || 1 will get key size

let alphasInSet = new Set();
let modsInSet = new Set();
let accentsInSet = new Set();

function getKeycapColorOptions(key, keycapsInfo) {
    // keep a list of all possible color options available for this keycap
    let colorOptions = [];

    if (ACCENTS.has(key)) {
        accentsInSet.add(key);
        colorOptions.push(...keycapsInfo.accents);
    }

    let exception;
    if ((exception = keycapsInfo.exceptions.find(e => e.keys.includes(key)))) {
        colorOptions.push(exception);
    } else if (ALPHAS.has(key)) {
        alphasInSet.add(key);
        colorOptions.push(keycapsInfo.alphas);
    } else {
        modsInSet.add(key);
        colorOptions.push(keycapsInfo.mods);
    }

    const extraOptions = keycapsInfo.extras.filter(e => e.keys.includes(key));
    colorOptions.push(...extraOptions);

    return {
        colorOptions,
        optionSelected: 0,
        keycapColor: colorOptions[0].keycapColor,
        legendColor: colorOptions[0].legendColor
    };
}





const toColor = (hex) => [hex.slice(1, 3), hex.slice(3, 5), hex.slice(5)].map(h => Number("0x" + h) / 255);

// To-do list:
// different cases
// different profiles
// different textures

// stepped caps
// store json files in DB
// make shaders cleaner; use uniform blocks maybe
// allow untextured keys and textured cases
// refactor to make working with buffers easier
// use webgl built in alpha blending (gl.enable(GL.BLEND))

// Test: Future funk, high voltage, metropolis, dmg, hallyu
// fonts: pixel, dots, etc

// UI
// implement in-stock/vendor tracking
// Implement show all/hide for filters with many items
// finish describing subjective colors
// allow selection for different base kits of same set (e.g. Modern dolch)
// upload favicon and update header




// TODO refactor this clusterfuck of a file

export class KeyboardRender extends React.Component {
    constructor(props) {
        super(props);

        this.state = {
            keyboardInfo: null,
            keycapsInfo: null,

            blinkProportion: 0,
            increasing: false,

            highlightKeys: false,
            fullCustom: false,
            keycapColor: "#000000",
            legendColor: "#ffffff",
            prevWidth: 0
        };

        this.gl = null;
        this.eye = {
            position: vec3.fromValues(0, 30, 30),
            lookAt: vec3.normalize(vec3.create(), vec3.fromValues(0, -1, -1)),
            lookUp: vec3.normalize(vec3.create(), vec3.fromValues(0, 1, -1)),
            yAngle: Math.PI / 4
        };
        this.progsInfo = {
            textured: newProgramInfo(),
            untextured: newProgramInfo(),
            selection: newProgramInfo()
        };
        
        this.tick = null;
        this.keyRenderInstructions = [];
        this.keyNameToKeyObj = {};
        this.objectIdToKey = {};

        this.webGlCanvas = React.createRef();

        this.handleToggleHighlight = this.handleToggleHighlight.bind(this);
        this.handleCustomizeKeycaps = this.handleCustomizeKeycaps.bind(this);
        this.handleResetKeycaps = this.handleResetKeycaps.bind(this);
        this.handleCanvasClicked = this.handleCanvasClicked.bind(this);
        this.handleCanvasMouseMove = this.handleCanvasMouseMove.bind(this);
        this.handleCanvasWheel = this.handleCanvasWheel.bind(this);
        this.handleResizeCanvas = this.handleResizeCanvas.bind(this);
    }

    async loadModels(keyboardInfo, keycapsInfo, keycapProfile) {
        // ---------------------------------------------------------------------------
        // prepare all necessary information for setting up key rendering instructions
        // ---------------------------------------------------------------------------
        // list of promises to load each model (keycaps and keyboard case)
        let resourceLoadPromises = [];
        let keycapModelsVisited = new Set();
        // find total number of units horizontally and vertically
        // to get number of units horizontally, find the keygroup that extends farthest right
        const numUnitsX = keyboardInfo.keyGroups.reduce(
            (rightmostUnits, keyGroup) => Math.max(
                rightmostUnits,
                keyGroup.keys.reduce(
                    (numU, key) => numU + (SPECIAL_NUM_UNITS[key] || 1),
                    keyGroup.offset[0]
                )
            ),
            0
        );
        // to get number of units vertically, find the keygroup that extends farthest down
        const numUnitsY = keyboardInfo.keyGroups.reduce((max, kg) => Math.max(max, kg.offset[1]), 0) + 1;
        const HEIGHT = 1.25;
        // define matrix for rotating an object by the keyboard incline and then moving it up to proper height
        const heightInclineMat = mat4.multiply(mat4.create(),
            mat4.fromTranslation(mat4.create(), vec3.fromValues(0, HEIGHT, 0)),
            mat4.fromRotation(mat4.create(), keyboardInfo.incline * (Math.PI / 180), [1, 0, 0]) // incline
        );
        // -------------------------------------------------
        // define instructions for rendering all needed keys
        // -------------------------------------------------
        for (const kg of keyboardInfo.keyGroups) {
            // initialize position to beginning of row and increment after each key
            let posXZ = [kg.offset[0] - numUnitsX / 2, 0, kg.offset[1] - numUnitsY / 2 + 0.5];
            for (const key of kg.keys) {
                // if this key is not special (non-1u), then it must be 1 unit wide
                const keysize = SPECIAL_NUM_UNITS[key] || 1;
                const keysizeStr = keysize.toString().replace(".", "_");
                const modelIdentifier = SPECIAL_KEYCAP_IDENTIFIERS.has(key) ? key : `R${kg.row}_${keysizeStr}U`;
    
                // if a keycap with these dimensions has not been loaded yet, then load it
                if (!keycapModelsVisited.has(modelIdentifier)) {
                    let bufs = this.progsInfo.textured.buffers;
                    bufs[modelIdentifier] = {};
                    resourceLoadPromises.push(
                        fetchKeycapModel(keycapProfile, modelIdentifier)
                            .then(keycapModel => loadGLBuffers(this.gl, bufs[modelIdentifier], keycapModel, true)));
                    keycapModelsVisited.add(modelIdentifier);
                }
    
                // move keycap to middle of keycap area
                const toPosMat = mat4.fromTranslation(mat4.create(), [posXZ[0] + keysize / 2, 0, posXZ[2]]);
                const finalTransformationMat = mat4.multiply(mat4.create(), heightInclineMat, toPosMat);
    
                // load legend texture
                const { loadTexturePromise, texture } = loadTexture(this.gl, "resources/legends/" + key + ".png");
                resourceLoadPromises.push(loadTexturePromise);
    
                // construct an object to represent all relevant information of a keycap for rendering
                const keycapObj = {
                    modelIdentifier,
                    keysize,
                    transformation: finalTransformationMat,
                    legendTexture: texture,
                    ...getKeycapColorOptions(key, keycapsInfo),
                };
    
                // find an appropriate object id for this key
                const objectId = Object.keys(this.objectIdToKey).length + 1;
                this.objectIdToKey[objectId] = keycapObj;
                this.keyNameToKeyObj[key] = keycapObj;
                keycapObj.objectId = objectId;
    
                this.keyRenderInstructions.push(keycapObj);
                posXZ[0] += keysize;
            }
        }
        const untexBufs = this.progsInfo.untextured.buffers;
    
        // load case
        untexBufs["case"] = {};
        resourceLoadPromises.push(
            fetchCaseModel("tofu65").then(trianglesInfo => loadGLBuffers(this.gl, untexBufs["case"], trianglesInfo, false)));
    
        // load switches
        untexBufs["switch"] = {};
        resourceLoadPromises.push(
            fetchSwitchModel().then(switchModel => loadGLBuffers(this.gl, untexBufs["switch"], switchModel, false)));
    
        // load switches
        untexBufs["stabilizer"] = {};
        resourceLoadPromises.push(
            fetchStabilizerModel().then(stabilizerModel => loadGLBuffers(this.gl, untexBufs["stabilizer"], stabilizerModel, false)));
    
        await Promise.all(resourceLoadPromises);
    }

    renderScene() {
        const { gl, eye, progsInfo, keyRenderInstructions } = this;

        gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    
        const projMat = mat4.perspective(mat4.create(), Math.PI / 9, 2, 0.1, 1000);
        const viewMat = mat4.lookAt(mat4.create(), eye.position, vec3.add(vec3.create(), eye.position, eye.lookAt), eye.lookUp);
        const viewProjMat = mat4.multiply(mat4.create(), projMat, viewMat);
    
        renderObject(gl, progsInfo.untextured, progsInfo.untextured.buffers["case"], {
            uEyePosition: [eye.position[0], eye.position[1], eye.position[2]],
            uMVPMat: [false, viewProjMat],
            uModelMat: [false, mat4.create()],
            uColor: [0.1, 0.1, 0.1]
        });
    
        // render keys
        for (const instr of keyRenderInstructions) {
            const modelViewProjMat = mat4.multiply(mat4.create(), viewProjMat, instr.transformation);
    
            const STAB_OFFSETS = {
                2: 0.65,
                2.25: 0.65,
                2.75: 0.65,
                6: 2.5,
                6.25: 2.5,
                7: 2.5
            };
    
            const stabOffset = STAB_OFFSETS[instr.keysize];
            if (stabOffset) {
                const renderStab = (offset) => {
                    const offsetMat = mat4.fromTranslation(mat4.create(), offset);
                    const transformation = mat4.multiply(mat4.create(), offsetMat, instr.transformation);
                    renderObject(gl, progsInfo.untextured, progsInfo.untextured.buffers["stabilizer"], {
                        uEyePosition: [eye.position[0], eye.position[1], eye.position[2]],
                        uMVPMat: [false, mat4.multiply(mat4.create(), viewProjMat, transformation)],
                        uModelMat: [false, transformation],
                        uColor: this.props.selectedItems["Stabilizers"].color.slice(0, 3) // TODO
                    });
                };
    
                renderStab([stabOffset, 0, 0]);
                renderStab([-stabOffset, 0, 0]);
            }
    
            // render keyswitch
            renderObject(gl, progsInfo.untextured, progsInfo.untextured.buffers["switch"], {
                uEyePosition: [eye.position[0], eye.position[1], eye.position[2]],
                uMVPMat: [false, modelViewProjMat],
                uModelMat: [false, instr.transformation],
                uColor: this.props.selectedItems["Switches"].casingColor
            });
    
            // render keycap
            gl.activeTexture(gl.TEXTURE0);
            gl.bindTexture(gl.TEXTURE_2D, instr.legendTexture);
    
            renderObject(gl, progsInfo.textured, progsInfo.textured.buffers[instr.modelIdentifier], {
                uEyePosition: [eye.position[0], eye.position[1], eye.position[2]],
                uMVPMat: [false, modelViewProjMat],
                uModelMat: [false, instr.transformation],
                uColor: instr.keycapColor,
                uTexture: [0],
                uTextureColor: instr.legendColor,
                uIsBlinking: [!this.state.fullCustom && this.state.highlightKeys && instr.colorOptions.length > 1],
                uBlinkProportion: [this.state.blinkProportion]
            });
        }
    
        // TODO maybe refactor this to first drawing all textured items and then untextured
    }

    handleToggleHighlight() {
        if (this.tick !== null) {
            clearInterval(this.tick);
            this.setState({ increasing: false, blinkProportion: 0 });
            this.tick = null;
        } else {
            this.tick = setInterval(() => {
                if (this.state.highlightKeys) {
                    this.setState(({ highlightKeys, increasing, blinkProportion }) => {
                        if (increasing) {
                            blinkProportion = Math.min(1, blinkProportion + 0.05);
                            increasing = blinkProportion !== 1;
                        } else {
                            blinkProportion = Math.max(0, blinkProportion - 0.05);
                            increasing = blinkProportion === 0;
                        }

                        return { highlightKeys, increasing, blinkProportion };
                    });
                }
            }, 20);
        }

        this.setState(currState => ({ highlightKeys: !currState.highlightKeys }));
        // this.renderScene();
    }

    handleColorMultiple(which) {
        const keys = { "alphas": alphasInSet, "mods": modsInSet, "accents": accentsInSet }[which];
        for (const keyName of keys) {
            const keyObj = this.keyNameToKeyObj[keyName];
            keyObj.keycapColor = toColor(this.state.keycapColor);
            keyObj.legendColor = toColor(this.state.legendColor);
        }

        // this.renderScene();
    }

    handleCustomizeKeycaps() {
        this.keycapColors = this.keyRenderInstructions.map(key => ({ keycapColor: key.keycapColor, legendColor: key.legendColor }));
        this.setState({ highlightKeys: false, fullCustom: true });
    }

    handleResetKeycaps() {
        for (const i in this.keyRenderInstructions) {
            this.keyRenderInstructions[i].keycapColor = this.keycapColors[i].keycapColor;
            this.keyRenderInstructions[i].legendColor = this.keycapColors[i].legendColor;
        }
        
        this.setState({ fullCustom: false });
    }

    handleCanvasClicked(event) {
        // const gl = this.gl;
        const { gl, eye, progsInfo, keyRenderInstructions } = this;

        if (event.clientX === this.beginClick.x && event.clientY === this.beginClick.y) {
            const { left, top, height } = event.target.getBoundingClientRect();

            const x = event.clientX - left;
            const y = height - (event.clientY - top);

            renderSelection(gl, eye, progsInfo, keyRenderInstructions);

            let pixelClicked = new Uint8Array(4);
            gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixelClicked);

            const objectWasClicked = pixelClicked[3] === 0;
            const objectId = pixelClicked[0];
            if (objectWasClicked && objectId !== 0) {
                const { fullCustom, keycapColor, legendColor } = this.state;

                const key = this.objectIdToKey[objectId];

                if (fullCustom) {
                    key.keycapColor = toColor(keycapColor);
                    key.legendColor = toColor(legendColor);
                } else {
                    key.optionSelected = (key.optionSelected + 1) % key.colorOptions.length;

                    key.keycapColor = key.colorOptions[key.optionSelected].keycapColor;
                    key.legendColor = key.colorOptions[key.optionSelected].legendColor;
                }
            }

            this.renderScene();
        }
    }

    handleCanvasMouseMove(event) {
        // const gl = this.gl;
        const { eye } = this;

        if (event.buttons !== 0) {
            // find how much the mouse has moved since the last position
            const dx = event.movementX;
            const dy = event.movementY;
            if (dx !== 0) {
                rotateView(-dx / 100, vec3.fromValues(0, 1, 0), eye);
            }
            if (dy !== 0) {
                // make it such that movement upwards is positive rotation
                const rotateAngle = dy / 100;
                // if this rotation will surpass lowest allowed viewing angle then clamp it
                const MIN_Y_ANG = 0.1;
                const MAX_Y_ANG = Math.PI / 2;
                const newAngle = Math.max(MIN_Y_ANG, Math.min(MAX_Y_ANG, eye.yAngle + rotateAngle));
                rotateView(newAngle - eye.yAngle, vec3.cross(vec3.create(), eye.lookUp, eye.lookAt), eye);
                eye.yAngle = newAngle;
            }
            this.renderScene();
        }
    }

    handleCanvasWheel(event) {
        event.preventDefault();
        // const gl = this.gl;
        const { eye } = this;

        const amtToMove = event.deltaY / 100;
        const dist = vec3.length(eye.position);
        // constrain the distance away from keyboard to [2, 10]
        const MIN_DIST = 14;
        const MAX_DIST = 50;
        const newDist = Math.max(MIN_DIST, Math.min(MAX_DIST, dist + amtToMove));
        eye.position = vec3.scale(vec3.create(), vec3.normalize(vec3.create(), eye.position), newDist);
        this.renderScene();
    }

    handleResizeCanvas() {
        // const gl = this.gl;
        const container = document.getElementById("render-container");

        const left = container.offsetLeft;
        const rightBound = window.innerWidth - container.style.marginRight.replace("px", "");
        const w = Math.max(600, rightBound - left);
        const h = Math.floor(w / 2);

        if (this.state.prevWidth !== w) {
            const canvas = this.webGlCanvas.current;
            canvas.width = w;
            canvas.height = h;

            this.gl.viewport(0, 0, w, h);

            this.setState({ prevWidth: w });
        }
    }

    async componentDidMount() {
        const canvas = this.webGlCanvas.current;
        canvas.addEventListener("wheel", this.handleCanvasWheel);
        window.addEventListener("resize", this.handleResizeCanvas);
        
        const gl = canvas.getContext("webgl");
        if (gl === null) {
            alert("Error in fetching GL context. Please ensure that your browser supports WebGL.");
            return;
        }
        this.gl = gl;

        gl.viewport(0, 0, canvas.width, canvas.height);

        // enable gl attributes: use z-buffering, make background black
        gl.clearColor(...toColor("#fcfcf8"), 1.0);
        gl.clearDepth(1.0);
        // gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
        // gl.enable(gl.BLEND);
        // gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
        gl.enable(gl.DEPTH_TEST);

        setupShaders(gl, this.progsInfo);

        const keyboardInfo = await fetchInfo("keyboardInfo", this.props.selectedItems["Case"]["Name"]);
        const keycapsInfo = await fetchInfo("keycapsInfo", this.props.selectedItems["Keycaps"]["Name"]);

        this.setState({ keyboardInfo, keycapsInfo });

        await this.loadModels(keyboardInfo, keycapsInfo, "cherry");

        this.forceUpdate();

        // this.handleResizeCanvas();
        // this.renderScene();
    }

    componentDidUpdate() {
        // this.handleResizeCanvas();
    }

    componentWillUnmount() {
        this.webGlCanvas.current.removeEventListener("wheel", this.handleCanvasWheel);
        window.removeEventListener("resize", this.handleResizeCanvas);
        if (this.tick) {
            clearInterval(this.tick);
            this.tick = null;
        }
        this.gl = null;
        
    }

    render() {
        return (
            <div id="keyboard-render">
                <canvas id="webgl-canvas"
                    ref={this.webGlCanvas}
                    onMouseDown={e => this.beginClick = { x: e.clientX, y: e.clientY }}
                    onMouseUp={this.handleCanvasClicked}
                    onMouseMove={this.handleCanvasMouseMove} />

                <div id="render-inputs">
                    
                    {this.state.fullCustom ? (
                        <React.Fragment>
                            <button onClick={this.handleResetKeycaps}>Reset</button>
                            <div>
                                {/* <div className="color-picker"> */}
                                <input type="color" id="keycap-color" value={this.state.keycapColor}
                                    onChange={e => this.setState({ keycapColor: e.target.value })} />
                                <label htmlFor="keycap-color">Keycap Color</label>
                                {/* </div> */}
                                {/* <div className="color-picker"> */}
                                <input type="color" id="legend-color" value={this.state.legendColor}
                                    onChange={e => this.setState({ legendColor: e.target.value })} />
                                <label htmlFor="legend-color">Legend Color</label>
                                {/* </div> */}
                            </div>
                            <button onClick={() => this.handleColorMultiple("alphas")}>Color Alphas</button>
                            <button onClick={() => this.handleColorMultiple("mods")}>Color Mods</button>
                            <button onClick={() => this.handleColorMultiple("accents")}>Color Accents</button>
                        </React.Fragment>
                    ) : (
                        <div>
                            <button onClick={this.handleCustomizeKeycaps}>Customize</button>
                            <input type="checkbox" id="highlight-changeable" onChange={this.handleToggleHighlight} />
                            <label htmlFor="highlight-changeable">Highlight Changeable Keys</label>
                        </div>
                    )}
                </div>
            </div>
        );
    }
}
