import * as cocoSsd from '@tensorflow-models/coco-ssd';
import '@tensorflow/tfjs';
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { XR, createXRStore, useXR, useXRInputSourceState, useXRHitTest } from '@react-three/xr'
import { useState, useRef, useEffect } from 'react'
import { Plane, Text } from "@react-three/drei";
import * as THREE from 'three'
import { pdfjs } from "react-pdf";
import './App.css'

pdfjs.GlobalWorkerOptions.workerSrc = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.8.69/pdf.worker.mjs`;



const store = createXRStore({ controller: {left:false}, hitTest: true, hand: false})

// Composant de détection d'écran
function ScreenDetector({ onScreenDetected }) {
  const videoRef = useRef();
  useEffect(() => {
    let stream;
    async function setupCamera() {
      stream = await navigator.mediaDevices.getUserMedia({ video: true });
      videoRef.current.srcObject = stream;
      await videoRef.current.play();
    }
    setupCamera();

    let model;
    cocoSsd.load().then((loadedModel) => {
      model = loadedModel;
      detectFrame();
    });

    async function detectFrame() {
      if (model && videoRef.current) {
        const predictions = await model.detect(videoRef.current);
        predictions.forEach(pred => {
          if (["tv", "laptop", "monitor"].includes(pred.class)) {
            console.log('Écran détecté !', pred);
            if (onScreenDetected) onScreenDetected(pred);
          }
        });
        requestAnimationFrame(detectFrame);
      }
    }
    return () => {
      if (stream) {
        stream.getTracks().forEach(track => track.stop());
      }
    };
  }, [onScreenDetected]);
  return <video ref={videoRef} width={640} height={480} autoPlay muted style={{display:'block',margin:'40px auto',borderRadius:'12px'}} />;
}

function DraggablePDF({ id, removePDF, initialPosition, file }) {
  // Empêche le déplacement du PDF dans la zone d'exclusion
  // Exclusion uniquement au relâchement
  const handleExclusion = () => {
    if (meshRef.current && window.__xr_anchor) {
      const anchor = window.__xr_anchor;
      const exclusionZoneSize = 1;
      meshRef.current.geometry.computeBoundingBox();
      const bbox = meshRef.current.geometry.boundingBox.clone();
      bbox.applyMatrix4(meshRef.current.matrixWorld);
      const zoneMin = new THREE.Vector3(
        anchor.x - exclusionZoneSize / 2,
        anchor.y - exclusionZoneSize / 2,
        anchor.z - exclusionZoneSize / 2
      );
      const zoneMax = new THREE.Vector3(
        anchor.x + exclusionZoneSize / 2,
        anchor.y + exclusionZoneSize / 2,
        anchor.z + exclusionZoneSize / 2
      );
      const exclusionBox = new THREE.Box3(zoneMin, zoneMax);
      if (bbox.intersectsBox(exclusionBox)) {
        console.log(`PDF ${id} (bbox) détecté dans la zone d'exclusion autour de l'ancre (${anchor.x.toFixed(2)}, ${anchor.y.toFixed(2)}, ${anchor.z.toFixed(2)}) | BBox PDF: min(${bbox.min.x.toFixed(2)},${bbox.min.y.toFixed(2)},${bbox.min.z.toFixed(2)}) max(${bbox.max.x.toFixed(2)},${bbox.max.y.toFixed(2)},${bbox.max.z.toFixed(2)})`);
        // Place le PDF au-dessus de la zone d'exclusion (modifie uniquement l'axe Y)
        // On prend la position monde actuelle pour x et z
        const currentWorldPos = new THREE.Vector3();
        meshRef.current.getWorldPosition(currentWorldPos);
        const newWorldPos = currentWorldPos.clone();
        newWorldPos.y = anchor.y + exclusionZoneSize / 2 + (bbox.max.y - bbox.min.y) / 2 + 0.2;
        if (meshRef.current.parent) {
          meshRef.current.position.copy(meshRef.current.parent.worldToLocal(newWorldPos));
        } else {
          meshRef.current.position.copy(newWorldPos);
        }
      }
    }
  };
  const { camera} = useThree();
  const isDraggingRef = useRef(false)
  const isPressing = useRef(false);
  const grabDistanceRef = useRef(1.5)
  const meshRef = useRef(null)
  const [numPages, setNumPages] = useState(1);
  const [currentPage, setCurrentPage] = useState(1);
  const texture = useRef(new THREE.Texture());
  const rightController = useXRInputSourceState("controller", "right");
  const [forceRender, setForceRender] = useState(0);
  const BACK_URL= import.meta.env.VITE_JAVA_BACK_URL;
  useFrame(() => {
    if (forceRender > 0) {
      setForceRender(forceRender - 1);
    }
  });


  useEffect(() => {
  if (!file) return;

  fetch(`${BACK_URL}/api/pdf-info?filename=${encodeURIComponent(file)}`)
    .then(res => res.json())
    .then(data => {
      if (data.pages) {
        setNumPages(data.pages);
      } else {
        console.warn("Erreur récupération info PDF :", data.error);
      }
    })
    .catch(err => {
      console.error("Erreur appel PDF info :", err);
    });
}, [file]);

  useEffect(() => {
  if (!file || !currentPage) return;

  fetch(`${BACK_URL}/api/render-pdf?filename=${encodeURIComponent(file)}&page=${currentPage}`)
    .then(res => res.blob())
    .then(blob => createImageBitmap(blob))
    .then(imageBitmap => {
      texture.current.image = imageBitmap;
      texture.current.needsUpdate = true;
    })
    .catch(err => console.error("Erreur chargement PDF depuis serveur :", err));
}, [file, currentPage]);


  const goToPage = (newPage) => {
    if (newPage >= 1 && newPage <= numPages) {
      setCurrentPage(newPage);
    }
  };

  // Make the doc to always look at the camera
  useFrame(() => {
    if (meshRef.current) {
      meshRef.current.lookAt(camera.position);
    }
  });

  // Movement with the stick
  useFrame(() => {
    if (!meshRef.current || !rightController) return;
    const thumbstick = rightController.gamepad["xr-standard-thumbstick"];
    if (thumbstick && isDraggingRef.current) {
      grabDistanceRef.current -= (thumbstick.yAxis ?? 0) * 0.05
    }
  });

  // Input management
  useFrame(() => {
    if (!meshRef.current || !rightController?.inputSource?.gamepad) return;

    const buttons = rightController.inputSource.gamepad.buttons;

    if (buttons[1]?.pressed && isDraggingRef.current) {
      removePDF(id);
    }

    if (buttons[4]?.pressed && !isPressing.current && isDraggingRef.current) {
      goToPage(currentPage + 1);
      isPressing.current = true;
    }

    if (buttons[5]?.pressed && !isPressing.current && isDraggingRef.current) {
      goToPage(currentPage - 1);
      isPressing.current = true;
    }

    if (!buttons[4]?.pressed && !buttons[5]?.pressed && isPressing.current) {
      isPressing.current = false;
    }
  });

  return (
    <mesh
      ref={meshRef}
      onPointerDown={(e) => {
        isDraggingRef.current = true

        // Calculate distance between pointer and document
        const cubeWorldPosition = new THREE.Vector3()
        console.log(cubeWorldPosition)
        meshRef.current.getWorldPosition(cubeWorldPosition)

        const distance = e.ray.origin.distanceTo(cubeWorldPosition)
        grabDistanceRef.current = distance

        // Keep the distance when grabbing
        const targetPosition = e.ray.origin.clone().add(e.ray.direction.clone().multiplyScalar(distance))
        meshRef.current?.position.copy(targetPosition)

        // make the document interactable
        e.stopPropagation()
      }}
      onPointerMove={(e) => {
        if (!isDraggingRef.current) return

        const targetPosition = e.ray.origin.clone().add(e.ray.direction.clone().multiplyScalar(grabDistanceRef.current))
        meshRef.current?.position.copy(targetPosition)

        e.stopPropagation()
      }}
      onPointerUp={(e) => {
        isDraggingRef.current = false;
        handleExclusion();
        e.stopPropagation();
      }}
    >
      <planeGeometry args={[1.5, 2]} />
      <meshStandardMaterial map={texture.current} transparent opacity={0.95} toneMapped={false} />
    </mesh>
  )
}

function VRMenu({ addPDF, pdfList }) {
  const [isMenuOpen, setMenuOpen] = useState(true);
  const [selectedFile, setSelectedFile] = useState("");
  const meshRef = useRef();
  const isPressing = useRef(false);
  

  // Get stick state
  const rightController = useXRInputSourceState("controller", "right");

  useFrame(() => {
    if(meshRef.current == null || rightController == null ){
      return
    }

    if (rightController?.inputSource?.gamepad) {
      const buttons = rightController.inputSource.gamepad.buttons;

      // Manage the opening and closing of the menu
      if (buttons[4]?.pressed && !isPressing.current && !buttons[0]?.pressed) {
        setMenuOpen((prev) => !prev);
        isPressing.current = true;
      }

      if (!buttons[4]?.pressed && isPressing.current) {
        isPressing.current = false;
      }
    }
  });

  return (
    <Plane
      position={[0, 1.5, -2]}
      args={[1.5, 1]}
      rotation={[-0.2, 0, 0]}
      visible={isMenuOpen}
    >
      <meshStandardMaterial ref={meshRef} color="gray" transparent opacity={0.8} />

      <Text position={[0, 0.35, 0]} fontSize={0.1}>
        📂 Sélectionner un PDF
      </Text>

      {pdfList.map((file, index) => (
        <Text
          key={index}
          position={[-0.5, 0.2 - index * 0.1, 0]}
          fontSize={0.08}
          color={selectedFile === file ? "yellow" : "white"}
          onClick={() => setSelectedFile(file)}
        >
          {file}
        </Text>
      ))}

      <Text
        position={[0, -0.3, 0]}
        fontSize={0.1}
        color="green"
        onClick={() => {
          if (selectedFile) {
            console.log(selectedFile)
            addPDF(selectedFile);
          }
        }}
      >
        ✅ Ajouter
      </Text>
    </Plane>
  );
}

function ManualHitTestAnchor({ setAnchor, hasAnchored }) {
  const { session } = useXR();
  const hitTestSourceRef = useRef(null);
  const viewerRefSpaceRef = useRef(null);

  useEffect(() => {
    if (!session) return;

    let cancelled = false;

    const init = async () => {
      const viewerSpace = await session.requestReferenceSpace("viewer");
      viewerRefSpaceRef.current = viewerSpace;

      const hitTestSource = await session.requestHitTestSource({ space: viewerSpace });
      hitTestSourceRef.current = hitTestSource;
      console.log("📡 Manual hit test source created");

      const onXRFrame = (time, frame) => {
        if (cancelled || !viewerRefSpaceRef.current || !hitTestSourceRef.current) return;

        const viewerPose = frame.getViewerPose(viewerRefSpaceRef.current);
        if (!viewerPose) {
          session.requestAnimationFrame(onXRFrame);
          return;
        }

        const results = frame.getHitTestResults(hitTestSourceRef.current);
        if (results.length > 0 && !hasAnchored) {
          const pose = results[0].getPose(viewerRefSpaceRef.current);
          if (pose) {
            const matrix = new THREE.Matrix4().fromArray(pose.transform.matrix);
            const pos = new THREE.Vector3().setFromMatrixPosition(matrix);
            console.log("🎯 Manual hit set anchor:", pos);
            setAnchor(pos);
          }
        }

        session.requestAnimationFrame(onXRFrame);
      };

      session.requestAnimationFrame(onXRFrame);
    };

    init();

    return () => {
      cancelled = true;
      if (hitTestSourceRef.current?.cancel) {
        hitTestSourceRef.current.cancel();
      }
    };
  }, [session, hasAnchored, setAnchor]);

  return null;
}



function AnchorVisual({ anchor, onConfirm }) {
  if (!anchor) {
    console.log("🟠 AnchorVisual: Pas d'ancre, sphère rouge affichée à [0, 1.2, -1]");
    return (
      <mesh position={[0, 1.2, -1]}>
        <sphereGeometry args={[0.05, 16, 16]} />
        <meshStandardMaterial color="red" />
      </mesh>
    );
  }

  console.log("🟢 AnchorVisual: Ancre trouvée à", anchor);
  return (
    <group>
      <mesh position={anchor}>
        <sphereGeometry args={[0.05, 16, 16]} />
        <meshStandardMaterial color="orange" />
      </mesh>
      <Text
        position={anchor.clone().add(new THREE.Vector3(0, 0.15, 0))}
        fontSize={0.05}
        color="white"
        onClick={onConfirm}
      >
        📌 Définir ici
      </Text>
    </group>
  );
}

function App() {
  const [xrStarted, setXRStarted] = useState(false);
  const [screenDetected, setScreenDetected] = useState(null);
  const [hasAnchored, setHasAnchored] = useState(false);
  const [anchor, setAnchor] = useState(null);
  const [pdfList, setPdfList] = useState([]);
  
  // Visualisation de la zone d'exclusion autour de l'ancre
  function ExclusionZone({ anchor, size }) {
    if (!anchor) return null;
    if (!showAR) {
      return (
        <div className="main-bg">
          <header className="header-bar">
            <img src="/logoSafranc.webp" alt="Logo Safran" className="logo-safran" />
            <h1 className="app-title">Projet VR</h1>
            <div className="header-right">
              <span className="matricule">Matricule Fictif</span>
              <span className="power-btn">
                <svg width="60" height="60" viewBox="0 0 60 60">
                  <circle cx="30" cy="30" r="25" stroke="white" strokeWidth="5" fill="none" />
                  <rect x="27.5" y="10" width="5" height="20" rx="2.5" fill="white" />
                </svg>
              </span>
            </div>
          </header>
          <div className="main-content">
            <p className="instruction-text">
              Pour entrer dans la version réalité augmentée de l’application, détectez d'abord un écran puis cliquez sur le bouton ci-dessous dans votre casque de réalité virtuelle :
            </p>
            {!screenDetected && (
              <ScreenDetector onScreenDetected={setScreenDetected} />
            )}
            {screenDetected && (
              <div style={{textAlign:'center',marginBottom:'30px'}}>
                <p style={{color:'#fff',fontSize:'1.2rem'}}>Écran détecté : <b>{screenDetected.class}</b></p>
                <button
                  className="enter-ar-btn"
                  onClick={async () => {
                    try {
                      await store.enterAR();
                      console.log("✅ Entered AR session");
                      setShowAR(true);
                      setXRStarted(true);
                    } catch (err) {
                      console.error("❌ Failed to enter AR", err);
                    }
                  }}
                >
                  Enter AR
                </button>
              </div>
            )}
          </div>
        </div>
      );
    }
  };


  useEffect(() => {
    fetch("/pdf-list.json")
      .then((res) => res.json())
      .then(setPdfList)
      .catch((err) => console.error("Erreur chargement PDF:", err));
  }, []);
 
  const addPDF = (newFile) => {
    if (!newFile || !anchor) return;
    const fileURL = `/${newFile}`;
    const offset = new THREE.Vector3(
      (Math.random() - 0.5) * 0.6,
      0.5 + Math.random() * 0.2,
      -0.5 + Math.random() * 0.2
    );
    const pdfPosition = anchor.clone().add(offset);

    // Vérifie la zone d'exclusion
    if (isInExclusionZone(pdfPosition)) {
      alert("Impossible d'instancier un PDF dans la zone d'exclusion autour de l'ancre !");
      return;
    }

    const newPDF = {
      id: Date.now(),
      position: [pdfPosition.x, pdfPosition.y, pdfPosition.z],
      file: fileURL,
    };
    setPDFs((prev) => [...prev, newPDF]);
  };

  const removePDF = (id) => {
    setPDFs((prev) => prev.filter((pdf) => pdf.id !== id));
  };

  return (
    <div className='global-display'>
      <header className="header-bar">
          <img src="/logoSafranc.webp" alt="Logo Safran" className="logo-safran" />
          <h1 className="app-title">Projet VR</h1>
          <div className="header-right">
            <span className="matricule">Matricule Fictif</span>
            <span className="power-btn">
              <svg width="60" height="60" viewBox="0 0 60 60">
                <circle cx="30" cy="30" r="25" stroke="white" strokeWidth="5" fill="none" />
                <rect x="27.5" y="10" width="5" height="20" rx="2.5" fill="white" />
              </svg>
            </span>
          </div>
        </header>
        <div className="main-content">
          <p className="instruction-text">
            Pour entrer dans la version réalité augmentée de l’application cliquez sur le<br />
            bouton si dessous dans votre casque de réalité virtuelle:
          </p>
          <button
            className="enter-ar-btn"
            onClick={async () => {
              try {
                await store.enterAR();
                console.log("✅ Entered AR session");
                setXRStarted(true);
              } catch (err) {
                console.error("❌ Failed to enter AR", err);
              }
            }}
          >
            Enter AR
          </button>
        </div>
      <Canvas >
        <ambientLight intensity={0.5} />
        <XR store={store} referenceSpace="local-floor">
          {xrStarted && (
            <ManualHitTestAnchor
            setAnchor={setAnchor}
            hasAnchored={hasAnchored}
          />
          )}
          {!hasAnchored && <AnchorVisual anchor={anchor} onConfirm={() => setHasAnchored(true)} />}

          {hasAnchored && (
            <>
              <ExclusionZone anchor={anchor} size={exclusionZoneSize} />
              {pdfs.map((pdf) => (
                <DraggablePDF
                  key={pdf.id}
                  id={pdf.id}
                  initialPosition={pdf.position}
                  file={pdf.file}
                  removePDF={removePDF}
                />
              ))}
              <VRMenu addPDF={addPDF} pdfList={pdfList} anchor={anchor} />
            </>
          )}
        </XR>
      </Canvas>
    </div>
  );
}

export default App;
