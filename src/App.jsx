import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { XR, createXRStore, useXR, useXRInputSourceState } from '@react-three/xr'
import { useState, useRef, useEffect } from 'react'
import { Plane, Text } from "@react-three/drei"
import * as THREE from 'three'
import { pdfjs } from "react-pdf"
import './App.css'

pdfjs.GlobalWorkerOptions.workerSrc = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.8.69/pdf.worker.mjs`

const store = createXRStore({ controller: {left:false}, hitTest: true, hand: false})
const cv = window.cv

// Composant pour le rayon de sélection du contrôleur
function ControllerRay({ isActive }) {
  const rightController = useXRInputSourceState("controller", "right")
  const lineRef = useRef()

  useFrame(() => {
    if (!rightController?.object || !lineRef.current || !isActive) return

    const controller = rightController.object
    const direction = new THREE.Vector3(0, 0, -1)
    direction.applyQuaternion(controller.quaternion)
    
    const start = controller.position.clone()
    const end = start.clone().add(direction.multiplyScalar(10))
    
    lineRef.current.geometry.setFromPoints([start, end])
  })

  if (!isActive) return null

  return (
    <line ref={lineRef}>
      <bufferGeometry />
      <lineBasicMaterial color="cyan" linewidth={2} />
    </line>
  )
}

function buildCameraMatrix(camera, width, height) {
  const fov = camera.fov * Math.PI / 180
  const fy = height / (2 * Math.tan(fov / 2))
  const fx = fy
  const cx = width / 2
  const cy = height / 2

  return cv.matFromArray(3, 3, cv.CV_64F, [
    fx, 0, cx,
    0, fy, cy,
    0, 0, 1
  ])
}

function getScreenCenter(corners) {
  let cx = 0, cy = 0
  for (let i = 0; i < 4; i++) {
    cx += corners.data32F[i * 2]
    cy += corners.data32F[i * 2 + 1]
  }
  return { x: cx / 4, y: cy / 4 }
}

function pixelToRayDirection(px, py, width, height, camera) {
  const ndc = new THREE.Vector3(
    (px / width) * 2 - 1,
    -(py / height) * 2 + 1,
    0.5
  )
  ndc.unproject(camera)
  return ndc.sub(camera.position).normalize()
}


function AutoScreenDetector({ onAnchorSet }) {
  const { getFrame } = useVisionCamera()
  const { camera, scene } = useThree()
  const raycaster = useRef(new THREE.Raycaster())

  const stableCount = useRef(0)
  const confirmed = useRef(false)

  useFrame(() => {
    if (confirmed.current) return

    const canvas = getFrame()
    if (!canvas || !window.cv) return

    const mat = cv.imread(canvas)
    const corners = detectScreen(mat)

    if (!corners) {
      stableCount.current = 0
      mat.delete()
      return
    }

    // 🕒 stabilité temporelle (≈ 0.5s à 30fps)
    stableCount.current++
    if (stableCount.current < 15) {
      mat.delete()
      corners.delete()
      return
    }

    console.log("✅ Écran détecté (stable)")

    // 📐 centre image
    const center = getScreenCenter(corners)

    // 🎯 direction XR
    const direction = pixelToRayDirection(
      center.x,
      center.y,
      canvas.width,
      canvas.height,
      camera
    )

    // 🔦 raycast XR
    raycaster.current.set(camera.position, direction)
    const hits = raycaster.current.intersectObjects(scene.children, true)

    if (hits.length === 0) {
      console.warn("⚠️ Raycast XR : aucun hit")
      mat.delete()
      corners.delete()
      return
    }

    const hit = hits[0]
    const distance = hit.point.distanceTo(camera.position)

    // 🔒 filtre distance réaliste écran
    if (distance < 0.6 || distance > 5) {
      console.warn("❌ Distance écran irréaliste:", distance)
      mat.delete()
      corners.delete()
      return
    }

    // 🛡️ sécurité WebXR
    if (!Number.isFinite(hit.point.x) ||
        !Number.isFinite(hit.point.y) ||
        !Number.isFinite(hit.point.z)) {
      console.warn("❌ Point XR invalide")
      mat.delete()
      corners.delete()
      return
    }

    console.log("🎯 Ancre XR validée:", hit.point)

    confirmed.current = true
    onAnchorSet(hit.point.clone())

    mat.delete()
    corners.delete()
  })

  return (
    <Text position={[0, 2, -1]} fontSize={0.08} color="cyan">
      🔍 Recherche automatique de l’écran…
    </Text>
  )
}



// Composant pour la sélection manuelle de l'écran
function ManualScreenSelector({ onAnchorSet }) {
  const [isSelecting, setIsSelecting] = useState(true)
  const [targetPoint, setTargetPoint] = useState(null)
  const rightController = useXRInputSourceState("controller", "right")
  const isPressing = useRef(false)
  const { scene } = useThree()

  useFrame(() => {
    if (!rightController?.inputSource?.gamepad || !isSelecting) return

    const buttons = rightController.inputSource.gamepad.buttons
    
    // Trigger pressé - on définit le point cible
    if (buttons[0]?.pressed && !isPressing.current) {
      isPressing.current = true
      
      // Récupérer la position et direction du contrôleur
      const controller = rightController.object
      if (!controller) return

      const raycaster = new THREE.Raycaster()
      const direction = new THREE.Vector3(0, 0, -1)
      direction.applyQuaternion(controller.quaternion)
      
      raycaster.set(controller.position, direction)
      
      // Créer un grand plan invisible pour détecter l'intersection
      const planeGeometry = new THREE.PlaneGeometry(100, 100)
      const planeMaterial = new THREE.MeshBasicMaterial({ 
        visible: false, 
        side: THREE.DoubleSide 
      })
      const detectionPlane = new THREE.Mesh(planeGeometry, planeMaterial)
      
      // Orienter le plan selon la direction du regard
      detectionPlane.position.set(0, 1.5, -2)
      detectionPlane.lookAt(controller.position)
      scene.add(detectionPlane)
      
      const intersects = raycaster.intersectObject(detectionPlane)
      
      if (intersects.length > 0) {
        const point = intersects[0].point
        setTargetPoint(point)
        console.log("🎯 Point cible détecté:", point)
      }
      
      scene.remove(detectionPlane)
      planeGeometry.dispose()
      planeMaterial.dispose()
    }

    // Bouton relâché
    if (!buttons[0]?.pressed && isPressing.current) {
      isPressing.current = false
    }

    // Bouton A (ou X) pour confirmer
    if (buttons[4]?.pressed && targetPoint && !isPressing.current) {
      console.log("✅ Ancrage confirmé à:", targetPoint)
      onAnchorSet(targetPoint)
      setIsSelecting(false)
      isPressing.current = true
    }
  })

  if (!isSelecting) return null

  return (
    <>
      <ControllerRay isActive={isSelecting} />
      
      {/* Instructions flottantes */}
      <Text
        position={[0, 2.2, -1.5]}
        fontSize={0.08}
        color="white"
        anchorX="center"
        anchorY="middle"
      >
        🎯 Pointez vers votre écran
      </Text>
      
      <Text
        position={[0, 2.05, -1.5]}
        fontSize={0.06}
        color="cyan"
        anchorX="center"
        anchorY="middle"
      >
        Trigger: Viser | Bouton A: Confirmer
      </Text>

      {/* Visualisation du point cible */}
      {targetPoint && (
        <group>
          <mesh position={targetPoint}>
            <sphereGeometry args={[0.05, 16, 16]} />
            <meshStandardMaterial color="lime" emissive="lime" emissiveIntensity={0.5} />
          </mesh>
          
          {/* Cercle de confirmation autour du point */}
          <mesh position={targetPoint} rotation={[Math.PI / 2, 0, 0]}>
            <ringGeometry args={[0.08, 0.12, 32]} />
            <meshBasicMaterial color="lime" transparent opacity={0.6} side={THREE.DoubleSide} />
          </mesh>

          <Text
            position={[targetPoint.x, targetPoint.y + 0.2, targetPoint.z]}
            fontSize={0.05}
            color="lime"
            anchorX="center"
          >
            ✅ Appuyez sur A pour confirmer
          </Text>
        </group>
      )}
    </>
  )
}

// Composant pour gérer les Spatial Anchors persistants
function PersistentAnchor({ position, onRestored }) {
  const { session } = useXR()
  const [anchorCreated, setAnchorCreated] = useState(false)

  useEffect(() => {
    if (!session || !position || anchorCreated) return

    const createAnchor = async () => {
      try {
        const referenceSpace = await session.requestReferenceSpace('local-floor')
        
        // Créer un XRRigidTransform à partir de la position
        const transform = new XRRigidTransform(
          { x: position.x, y: position.y, z: position.z },
          { x: 0, y: 0, z: 0, w: 1 }
        )

        // Créer l'ancre
        const anchor = await session.createAnchor(transform, referenceSpace)
        
        if (anchor) {
          console.log("🔗 Spatial Anchor créé avec succès")
          
          // Sauvegarder dans localStorage pour persistance
          const anchorData = {
            position: { x: position.x, y: position.y, z: position.z },
            timestamp: Date.now()
          }
          localStorage.setItem('screenAnchor', JSON.stringify(anchorData))
          
          setAnchorCreated(true)
        }
      } catch (error) {
        console.warn("⚠️ Spatial Anchors non supporté, utilisation de localStorage uniquement", error)
        
        // Fallback: sauvegarder uniquement dans localStorage
        const anchorData = {
          position: { x: position.x, y: position.y, z: position.z },
          timestamp: Date.now()
        }
        localStorage.setItem('screenAnchor', JSON.stringify(anchorData))
        setAnchorCreated(true)
      }
    }

    createAnchor()
  }, [session, position, anchorCreated])

  // Restaurer l'ancre au démarrage
  useEffect(() => {
    const savedAnchor = localStorage.getItem('screenAnchor')
    if (savedAnchor && onRestored) {
      const anchorData = JSON.parse(savedAnchor)
      const pos = new THREE.Vector3(
        anchorData.position.x,
        anchorData.position.y,
        anchorData.position.z
      )
      console.log("📌 Ancre restaurée depuis localStorage:", pos)
      onRestored(pos)
    }
  }, [onRestored])

  return null
}

function DraggablePDF({ id, removePDF, initialPosition, file }) {
  const handleExclusion = () => {
    if (meshRef.current && window.__xr_anchor) {
      const anchor = window.__xr_anchor
      const exclusionZoneSize = 1
      meshRef.current.geometry.computeBoundingBox()
      const bbox = meshRef.current.geometry.boundingBox.clone()
      bbox.applyMatrix4(meshRef.current.matrixWorld)

      const zoneMin = new THREE.Vector3(
        anchor.x - exclusionZoneSize / 2,
        anchor.y - exclusionZoneSize / 2,
        anchor.z - exclusionZoneSize / 2
      )
      const zoneMax = new THREE.Vector3(
        anchor.x + exclusionZoneSize / 2,
        anchor.y + exclusionZoneSize / 2,
        anchor.z + exclusionZoneSize / 2
      )
      const exclusionBox = new THREE.Box3(zoneMin, zoneMax)

      if (bbox.intersectsBox(exclusionBox)) {
        console.log(`🚫 PDF ${id} détecté dans la zone d'exclusion — repositionnement.`)

        const currentWorldPos = new THREE.Vector3()
        meshRef.current.getWorldPosition(currentWorldPos)

        const fixedOffsetY = 1

        const newWorldPos = currentWorldPos.clone()
        newWorldPos.y = anchor.y + exclusionZoneSize / 2 + fixedOffsetY

        setWorldPosition(meshRef.current, newWorldPos)
      }
    }
  }

  const { camera } = useThree()
  const isDraggingRef = useRef(false)
  const isPressing = useRef(false)
  const grabDistanceRef = useRef(1.5)
  const meshRef = useRef(null)
  const [numPages, setNumPages] = useState(1)
  const [currentPage, setCurrentPage] = useState(1)
  const texture = useRef(new THREE.Texture())
  const rightController = useXRInputSourceState("controller", "right")
  const [forceRender, setForceRender] = useState(0)
  const BACK_URL = import.meta.env.VITE_JAVA_BACK_URL

  useFrame(() => {
    if (forceRender > 0) {
      setForceRender(forceRender - 1)
    }
  })

  useEffect(() => {
    if (!file) return

    fetch(`${BACK_URL}/api/pdf-info?filename=${encodeURIComponent(file)}`)
      .then(res => res.json())
      .then(data => {
        if (data.pages) {
          setNumPages(data.pages)
        } else {
          console.warn("Erreur récupération info PDF :", data.error)
        }
      })
      .catch(err => {
        console.error("Erreur appel PDF info :", err)
      })
  }, [file])

  useEffect(() => {
    if (!file || !currentPage) return

    fetch(`${BACK_URL}/api/render-pdf?filename=${encodeURIComponent(file)}&page=${currentPage}`)
      .then(res => res.blob())
      .then(blob => createImageBitmap(blob))
      .then(imageBitmap => {
        texture.current.image = imageBitmap
        texture.current.needsUpdate = true
      })
      .catch(err => console.error("Erreur chargement PDF depuis serveur :", err))
  }, [file, currentPage])

  const goToPage = (newPage) => {
    if (newPage >= 1 && newPage <= numPages) {
      setCurrentPage(newPage)
    }
  }

  useFrame(() => {
    if (meshRef.current) {
      meshRef.current.lookAt(camera.position)
    }
  })

  useFrame(() => {
    if (!meshRef.current || !rightController) return
    const thumbstick = rightController.gamepad["xr-standard-thumbstick"]
    if (!thumbstick || !isDraggingRef.current) return

    const x = thumbstick.xAxis ?? 0
    const y = thumbstick.yAxis ?? 0

    const deadzone = 0.05
    const absX = Math.abs(x)
    const absY = Math.abs(y)

    if (absY > absX && absY > deadzone) {
      grabDistanceRef.current -= y * 0.05
    } else if (absX > absY && absX > deadzone) {
      const scaleChange = x * 0.02
      const newScale = meshRef.current.scale.x + scaleChange
      meshRef.current.scale.setScalar(Math.max(0.2, Math.min(3, newScale)))
    }
  })

  useFrame(() => {
    if (!meshRef.current || !rightController?.inputSource?.gamepad) return

    const buttons = rightController.inputSource.gamepad.buttons

    if (buttons[5]?.pressed && isDraggingRef.current) {
      removePDF(id)
    }

    if (buttons[4]?.pressed && !isPressing.current && isDraggingRef.current) {
      if (currentPage == numPages) {
        goToPage(1)
        isPressing.current = true
      } else {
        goToPage(currentPage + 1)
        isPressing.current = true
      }
    }

    if (!buttons[4]?.pressed && !buttons[5]?.pressed && isPressing.current) {
      isPressing.current = false
    }
  })

  return (
    <mesh
      ref={meshRef}
      position={initialPosition}
      onPointerDown={(e) => {
        isDraggingRef.current = true

        const cubeWorldPosition = new THREE.Vector3()
        meshRef.current.getWorldPosition(cubeWorldPosition)

        const distance = e.ray.origin.distanceTo(cubeWorldPosition)
        grabDistanceRef.current = distance

        const targetPosition = e.ray.origin.clone().add(e.ray.direction.clone().multiplyScalar(distance))
        meshRef.current?.position.copy(targetPosition)

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
        handleExclusion()
        e.stopPropagation()
      }}
    >
      <planeGeometry args={[1.5, 2]} />
      <meshStandardMaterial map={texture.current} transparent opacity={0.95} toneMapped={false} />
    </mesh>
  )
}

function setWorldPosition(obj, worldPos) {
  obj.updateMatrixWorld(true)
  if (obj.parent) {
    const localPos = worldPos.clone()
    obj.parent.worldToLocal(localPos)
    obj.position.copy(localPos)
  } else {
    obj.position.copy(worldPos)
  }
}

function useVisionCamera() {
  const videoRef = useRef(null)
  const canvasRef = useRef(null)

  useEffect(() => {
    const video = document.createElement("video")
    video.autoplay = true
    video.playsInline = true

    const canvas = document.createElement("canvas")
    const ctx = canvas.getContext("2d")

    navigator.mediaDevices.getUserMedia({
      video: { facingMode: "environment" }
    }).then(stream => {
      video.srcObject = stream
    })

    videoRef.current = video
    canvasRef.current = canvas
  }, [])

  const getFrame = () => {
    const video = videoRef.current
    const canvas = canvasRef.current
    if (!video || !canvas) return null

    if (video.videoWidth === 0 || video.videoHeight === 0) return null

    canvas.width = video.videoWidth
    canvas.height = video.videoHeight
    const ctx = canvas.getContext("2d")
    ctx.drawImage(video, 0, 0)

    return canvas
  }

  return { videoRef, getFrame }
}

export function detectScreen(mat) {
  const gray = new cv.Mat()
  const blurred = new cv.Mat()
  const thresh = new cv.Mat()
  const contours = new cv.MatVector()
  const hierarchy = new cv.Mat()

  cv.cvtColor(mat, gray, cv.COLOR_RGBA2GRAY)
  cv.GaussianBlur(gray, blurred, new cv.Size(5, 5), 0)

  // Écran sombre
  cv.threshold(blurred, thresh, 60, 255, cv.THRESH_BINARY_INV)

  const kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(5, 5))
  cv.morphologyEx(thresh, thresh, cv.MORPH_CLOSE, kernel)

  cv.findContours(
    thresh,
    contours,
    hierarchy,
    cv.RETR_EXTERNAL,
    cv.CHAIN_APPROX_SIMPLE
  )

  let best = null
  let bestArea = 0
  const imageArea = mat.rows * mat.cols

  for (let i = 0; i < contours.size(); i++) {
    const cnt = contours.get(i)
    const area = cv.contourArea(cnt)

    // 🔒 filtre surface minimale (8% image)
    if (area < imageArea * 0.08) {
      cnt.delete()
      continue
    }

    const approx = new cv.Mat()
    cv.approxPolyDP(cnt, approx, 0.02 * cv.arcLength(cnt, true), true)

    if (approx.rows === 4) {
      const rect = cv.boundingRect(approx)
      const ratio = rect.width / rect.height

      // 🔒 filtre ratio écran
      if (ratio > 1.2 && ratio < 2.2 && area > bestArea) {
        best?.delete()
        best = approx.clone()
        bestArea = area
      }
    }

    approx.delete()
    cnt.delete()
  }

  gray.delete()
  blurred.delete()
  thresh.delete()
  contours.delete()
  hierarchy.delete()

  return best
}



 function estimatePose(corners2D, screenWidth, screenHeight, cameraMatrix) {
  const objectPoints = cv.matFromArray(4, 1, cv.CV_32FC3, [
    -screenWidth/2,  screenHeight/2, 0,
     screenWidth/2,  screenHeight/2, 0,
     screenWidth/2, -screenHeight/2, 0,
    -screenWidth/2, -screenHeight/2, 0,
  ])

  const imagePoints = cv.matFromArray(4, 1, cv.CV_32FC2, corners2D)

  const rvec = new cv.Mat()
  const tvec = new cv.Mat()

  cv.solvePnP(objectPoints, imagePoints, cameraMatrix, new cv.Mat(), rvec, tvec)

  return { rvec, tvec }
}



function VRMenu({ addPDF, pdfList }) {
  const [isMenuOpen, setMenuOpen] = useState(true)
  const [selectedFile, setSelectedFile] = useState("")
  const meshRef = useRef()
  const isPressing = useRef(false)

  const rightController = useXRInputSourceState("controller", "right")

  useFrame(() => {
    if (meshRef.current == null || rightController == null) {
      return
    }

    if (rightController?.inputSource?.gamepad) {
      const buttons = rightController.inputSource.gamepad.buttons

      if (buttons[4]?.pressed && !isPressing.current && !buttons[0]?.pressed) {
        setMenuOpen((prev) => !prev)
        isPressing.current = true
      }

      if (!buttons[4]?.pressed && isPressing.current) {
        isPressing.current = false
      }
    }
  })

  return (
    <Plane
      position={[0, 1.5, -2]}
      args={[1.5, 1]}
      rotation={[-0.2, 0, 0]}
      visible={isMenuOpen}
    >
      <meshStandardMaterial ref={meshRef} color="gray" transparent opacity={1} />

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
            addPDF(selectedFile)
          }
        }}
      >
        ✅ Ajouter
      </Text>
    </Plane>
  )
}

function ExclusionZone({ anchor, size }) {
  if (!anchor) return null
  return (
    <mesh position={anchor}>
      <boxGeometry args={[size.x, size.y, size.z]} />
      <meshStandardMaterial color="red" transparent opacity={0.3} wireframe />
    </mesh>
  )
}

function App() {
  const [pdfs, setPDFs] = useState([])
  const [pdfList, setPdfList] = useState([])
  const [anchor, setAnchor] = useState(null)
  const [hasAnchored, setHasAnchored] = useState(false)
  const [xrStarted, setXRStarted] = useState(false)

  useEffect(() => {
  const waitForCV = () => {
    if (window.cv && window.cv.Mat) {
      console.log("OpenCV ready")
    } else {
      setTimeout(waitForCV, 100)
    }
  }
  waitForCV()
}, [])

  useEffect(() => {
    if (anchor) {
      window.__xr_anchor = anchor
    }
  }, [anchor])

  const exclusionZoneSize = { x: 1, y: 0.3, z: 0.75 }

  const isInExclusionZone = (position) => {
    if (!anchor) return false
    let posVec
    if (Array.isArray(position)) {
      posVec = new THREE.Vector3(...position)
    } else if (position instanceof THREE.Vector3) {
      posVec = position
    } else {
      return false
    }
    return (
      Math.abs(posVec.x - anchor.x) < exclusionZoneSize.x / 2 &&
      Math.abs(posVec.y - anchor.y) < exclusionZoneSize.y / 2 &&
      Math.abs(posVec.z - anchor.z) < exclusionZoneSize.z / 2
    )
  }

  useEffect(() => {
    fetch("/pdf-list.json")
      .then((res) => res.json())
      .then(setPdfList)
      .catch((err) => console.error("Erreur chargement PDF:", err))
  }, [])

  const addPDF = (newFile) => {
    if (!newFile || !anchor) return
    const fileURL = `/${newFile}`
    const offsetY = exclusionZoneSize.y / 2 + 1
    const pdfPosition = new THREE.Vector3(
      anchor.x,
      anchor.y + offsetY,
      anchor.z
    )

    if (isInExclusionZone(pdfPosition)) {
      alert("Impossible d'instancier un PDF dans la zone d'exclusion autour de l'ancre !")
      return
    }

    const newPDF = {
      id: Date.now(),
      position: [pdfPosition.x, pdfPosition.y, pdfPosition.z],
      file: fileURL,
    }
    setPDFs((prev) => [...prev, newPDF])
  }

  const removePDF = (id) => {
    setPDFs((prev) => prev.filter((pdf) => pdf.id !== id))
  }

  const handleAnchorSet = (position) => {
    setAnchor(position)
    setHasAnchored(true)
    console.log("🎯 Ancre définie à:", position)
  }

  const handleAnchorRestored = (position) => {
    setAnchor(position)
    setHasAnchored(true)
  }

  const resetAnchor = () => {
    localStorage.removeItem('screenAnchor')
    setAnchor(null)
    setHasAnchored(false)
    setPDFs([])
    console.log("🔄 Ancre réinitialisée")
  }

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
          Pour entrer dans la version réalité augmentée de l'application cliquez sur le<br />
          bouton ci-dessous dans votre casque de réalité virtuelle:
        </p>
        <button
          className="enter-ar-btn"
          onClick={async () => {
            try {
              await store.enterAR()
              console.log("✅ Entered AR session")
              setXRStarted(true)
            } catch (err) {
              console.error("❌ Failed to enter AR", err)
            }
          }}
        >
          Enter AR
        </button>
        {xrStarted && hasAnchored && (
          <button
            className="enter-ar-btn"
            style={{ marginTop: '10px', background: '#dc3545' }}
            onClick={resetAnchor}
          >
            Réinitialiser l'ancre
          </button>
        )}
      </div>
      <Canvas>
        <ambientLight intensity={0.5} />
        <pointLight position={[10, 10, 10]} />
        <XR store={store} referenceSpace="local-floor">
          {xrStarted && !hasAnchored && (
            <AutoScreenDetector onAnchorSet={handleAnchorSet} />
          )}

          {xrStarted && (
            <PersistentAnchor 
              position={anchor} 
              onRestored={handleAnchorRestored}
            />
          )}

          {hasAnchored && anchor && (
            <>
              <ExclusionZone anchor={anchor} size={exclusionZoneSize} />
              
              {/* Marqueur visuel de l'ancre */}
              <mesh position={anchor}>
                <sphereGeometry args={[0.05, 16, 16]} />
                <meshStandardMaterial color="green" emissive="green" emissiveIntensity={0.8} />
              </mesh>

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
  )
}

export default App