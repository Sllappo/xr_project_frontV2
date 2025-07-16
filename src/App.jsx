import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { XR, createXRStore, useXR, useXRInputSourceState } from '@react-three/xr'
import { useState, useRef, useEffect } from 'react'
import { Plane, Text } from "@react-three/drei";
import * as THREE from 'three'
import { pdfjs } from "react-pdf";

pdfjs.GlobalWorkerOptions.workerSrc = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.8.69/pdf.worker.mjs`;



const store = createXRStore({ controller: {left:false}, hitTest: true, hand: false})

function DraggablePDF({ id, removePDF, initialPosition, file }) {
  const { camera, invalidate} = useThree();
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
      invalidate();
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
      invalidate();
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
        isDraggingRef.current = false
        e.stopPropagation()
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

function App() {
  const [pdfs, setPDFs] = useState([]);
  const [pdfList, setPdfList] = useState([]);

  useEffect(() => {
    setPDFs([{ id: 1, position: [0, 1, -1.5], file: "/test.pdf" }]);
  }, []); 
  
  useEffect(() => {
    fetch("/pdf-list.json")
      .then((res) => res.json())
      .then(setPdfList)
      .catch((err) => console.error("Erreur lors du chargement de la liste des PDFs :", err));
  }, []);

  const addPDF = (newFile) => {
    if (!newFile) return;
    console.log("XR is presenting:", store.getState().isPresenting);

    const fileURL = `/${newFile}`; // 📄 Files in `public/`

    const newPDF = {
      id: Date.now(),
      position: [-2, 1.5, -2],
      file: fileURL,
    };

    setPDFs((prev) => [...prev, newPDF]);
  };

  const removePDF = (id) => {
    setPDFs((prev) => prev.filter((pdf) => pdf.id !== id));
  };


  return(
    <div className='globalDisplay'>
      <button onClick={() => store.enterAR()}>Enter AR</button>
      <Canvas frameloop="always">
          <ambientLight intensity={0.5} />
          <XR store={store} >
            {pdfs.map((pdf) => (
                <DraggablePDF key={pdf.id} id={pdf.id} initialPosition={pdf.position} file={pdf.file} removePDF={removePDF} />
              ))}
            <VRMenu addPDF={addPDF} pdfList={pdfList} />
        </XR>
      </Canvas>
    </div>
  )
}

export default App
