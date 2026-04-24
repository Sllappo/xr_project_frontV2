import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { XR, createXRStore, useXR, useXRInputSourceState, useXRHitTest} from '@react-three/xr'
import { useState, useRef, useEffect } from 'react'
import { Plane, Text } from "@react-three/drei"
import * as THREE from 'three'
import { pdfjs } from "react-pdf"
import './App.css'

pdfjs.GlobalWorkerOptions.workerSrc = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.8.69/pdf.worker.mjs`

const matrixHelper = new THREE.Matrix4()
const hitPositionHelper = new THREE.Vector3()

const store = createXRStore({ controller: {left:false}, hitTest: true, hand: false, sessionInit: {
    requiredFeatures: ['hit-test', 'plane-detection'],
    optionalFeatures: ['anchors', 'local-floor']
  }})
const cv = window.cv

function RoomCaptureManager({ onRoomReady }) {
  const { session } = useXR()
  const hasChecked = useRef(false)

  useEffect(() => {
    if (!session || hasChecked.current) return

    const timer = setTimeout(() => {
      hasChecked.current = true

      session.requestAnimationFrame((time, xrFrame) => {
        const planes = xrFrame?.detectedPlanes
        const hasPlanes = planes && planes.size > 0

        if (!hasPlanes && typeof session.initiateRoomCapture === 'function') {
          console.log("🏠 Lancement du Room Capture...")
          session.initiateRoomCapture()
            .then(() => {
              console.log("✅ Room Capture terminé")
              onRoomReady() // → passe à l'étape suivante
            })
            .catch(err => console.warn("⚠️ Erreur Room Capture:", err))
        } else {
          console.log("✅ Plans déjà présents")
          onRoomReady() // → passe à l'étape suivante directement
        }
      })
    }, 3000)

    session.requestAnimationFrame((time, xrFrame) => {
    // ✅ Tester detectedMeshes
    const meshes = xrFrame?.detectedMeshes
    console.log("🕸️ Meshes détectés:", meshes?.size)
    if (meshes) {
      for (const mesh of meshes) {
        console.log(`  - label: "${mesh.semanticLabel}"`)
      }
    }
  })

    return () => clearTimeout(timer)
  }, [session])

  return (
    <Text position={[0, 2.1, -1.5]} fontSize={0.07} color="white" anchorX="center">
      🏠 Configuration de la pièce en cours...
    </Text>
  )
}

function ScreenAnchorSelector({ onAnchorSet }) {
  const { gl } = useThree()
  const rightController = useXRInputSourceState("controller", "right")
  const isPressing = useRef(false)
  const anchorSet = useRef(false)
  const [previewPosition, setPreviewPosition] = useState(null)
  const [previewSize, setPreviewSize] = useState(null)
  const lastHitPlane = useRef(null)
  const screenMeshPosition = useRef(null)
  const lastWidth = useRef(null)
  const lastHeight = useRef(null)

  useXRHitTest(
    (results, getWorldMatrix) => {
      if (results.length === 0) {
        setPreviewPosition(null)
        setPreviewSize(null)
        lastHitPlane.current = null
        return
      }

      getWorldMatrix(matrixHelper, results[0])
      const pos = hitPositionHelper.setFromMatrixPosition(matrixHelper)
      setPreviewPosition(pos.clone())

      // Récupérer le plan WebXR associé au hit pour avoir son polygone
      const xrHitResult = results[0]
      if (xrHitResult.sourceInput) {
        lastHitPlane.current = null
      }
    },
    'viewer',
    ['mesh']
  )

  useFrame((state, delta, xrFrame) => {
    if (anchorSet.current) return
    if (!xrFrame || !previewPosition) return

    const meshes = xrFrame.detectedMeshes
    const refSpace = gl.xr.getReferenceSpace()
    if (!meshes || !refSpace) return

    let closestMesh = null
    let closestDist = Infinity

    for (const mesh of meshes) {
      if (mesh.semanticLabel !== "screen") continue

      const pose = xrFrame.getPose(mesh.meshSpace, refSpace)
      if (!pose) continue

      const meshPos = new THREE.Vector3(
        pose.transform.position.x,
        pose.transform.position.y,
        pose.transform.position.z
      )

      const dist = meshPos.distanceTo(previewPosition)
      console.log(`🖥️ Screen mesh trouvé — dist: ${dist.toFixed(2)}m`)

      if (dist < closestDist) {
        closestDist = dist
        closestMesh = { mesh, pose }
      }
    }

    if (!closestMesh) return

    const pose = closestMesh.pose
    const q = pose.transform.orientation
    const planeQuat = new THREE.Quaternion(q.x, q.y, q.z, q.w)
    const planeMatrix = new THREE.Matrix4().makeRotationFromQuaternion(planeQuat)

    const vertices = closestMesh.mesh.vertices
    if (!vertices || vertices.length === 0) return

    // ✅ Calculer min/max en espace LOCAL (sans rotation)
    let minX = Infinity, maxX = -Infinity
    let minY = Infinity, maxY = -Infinity
    let minZ = Infinity, maxZ = -Infinity

    for (let i = 0; i < vertices.length; i += 3) {
      const x = vertices[i]
      const y = vertices[i + 1]
      const z = vertices[i + 2]

      minX = Math.min(minX, x); maxX = Math.max(maxX, x)
      minY = Math.min(minY, y); maxY = Math.max(maxY, y)
      minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z)
    }

    // ✅ Centre en espace local
    const centerLocal = new THREE.Vector3(
      (minX + maxX) / 2,
      (minY + maxY) / 2,
      (minZ + maxZ) / 2
    )

    // ✅ Appliquer rotation + translation pour passer en espace world
    const meshWorldPos = new THREE.Vector3(
      pose.transform.position.x,
      pose.transform.position.y,
      pose.transform.position.z
    )

    const centerWorld = centerLocal
      .clone()
      .applyQuaternion(planeQuat)  // rotation
      .add(meshWorldPos)           // translation

    console.log("📍 Centre géométrique:", centerWorld)

    // ✅ Calculer les dimensions en espace local également
    const rangesLocal = [
      { val: maxX - minX },
      { val: maxY - minY },
      { val: maxZ - minZ },
    ].sort((a, b) => b.val - a.val)

    const width = rangesLocal[0].val
    const height = rangesLocal[1].val

    if (width > 0.1 && height > 0.1) {
      const hasChanged = 
        !lastWidth.current || 
        !lastHeight.current ||
        Math.abs(lastWidth.current - width) > 0.01 ||
        Math.abs(lastHeight.current - height) > 0.01

      if (hasChanged) {
        lastWidth.current = width
        lastHeight.current = height
        setPreviewSize({ width, height })
        lastHitPlane.current = { width, height }
        screenMeshPosition.current = centerWorld
      }
    }
  })

  // Confirmer l'ancre au trigger
  useFrame(() => {
    if (!rightController?.inputSource?.gamepad || !previewPosition || anchorSet.current) return
    const buttons = rightController.inputSource.gamepad.buttons

    if (buttons[0]?.pressed && !isPressing.current) {
      isPressing.current = true
      anchorSet.current = true

      // ✅ Utiliser le centre du mesh plutôt que le point hitté
      const anchorPosition = screenMeshPosition.current ?? previewPosition.clone()
      onAnchorSet(anchorPosition, lastHitPlane.current)
    }
    if (!buttons[0]?.pressed) isPressing.current = false
  })

  return (
    <>
      {/* Réticule + aperçu de la zone d'exclusion */}
      {previewPosition && (
        <group position={previewPosition}>

          {/* Point central */}
          <mesh>
            <sphereGeometry args={[0.02, 16, 16]} />
            <meshBasicMaterial color="cyan" />
          </mesh>

          {/* Aperçu de la taille du plan détecté */}
          {previewSize && (
            <>
              {/* Contour de l'écran détecté */}
              <mesh>
                <planeGeometry args={[previewSize.width, previewSize.height]} />
                <meshBasicMaterial
                  color="cyan"
                  transparent
                  opacity={0.15}
                  side={THREE.DoubleSide}
                  wireframe={false}
                />
              </mesh>
              {/* Bordure wireframe */}
              <lineSegments>
                <edgesGeometry args={[new THREE.PlaneGeometry(previewSize.width, previewSize.height)]} />
                <lineBasicMaterial color="cyan" />
              </lineSegments>

              <Text
                position={[0, previewSize.height / 2 + 0.1, 0]}
                fontSize={0.05}
                color="cyan"
                anchorX="center"
              >
                {`${(previewSize.width * 100).toFixed(0)} × ${(previewSize.height * 100).toFixed(0)} cm`}
              </Text>
            </>
          )}
        </group>
      )}

      <Text
        position={[0, 2.1, -1.5]}
        fontSize={0.07}
        color={previewPosition ? "lime" : "white"}
        anchorX="center"
      >
        {previewPosition
          ? previewSize
            ? `🖥️ Écran détecté — Trigger pour ancrer`
            : `🔍 Surface trouvée — Centrez sur l'écran`
          : `🔍 Regardez vers votre écran...`}
      </Text>
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

function DraggablePDF({ id, removePDF, initialPosition, file, exclusionZoneSize }) {
  const handleExclusion = () => {
    if (!meshRef.current || !window.__xr_anchor) return
    const anchor = window.__xr_anchor

    meshRef.current.geometry.computeBoundingBox()
    const bbox = meshRef.current.geometry.boundingBox.clone()
    bbox.applyMatrix4(meshRef.current.matrixWorld)

    // ✅ Utiliser exclusionZoneSize depuis les props
    const zoneMin = new THREE.Vector3(
      anchor.x - exclusionZoneSize.x / 2,
      anchor.y - exclusionZoneSize.y / 2,
      anchor.z - exclusionZoneSize.z / 2
    )
    const zoneMax = new THREE.Vector3(
      anchor.x + exclusionZoneSize.x / 2,
      anchor.y + exclusionZoneSize.y / 2,
      anchor.z + exclusionZoneSize.z / 2
    )
    const exclusionBox = new THREE.Box3(zoneMin, zoneMax)

    const currentWorldPos = new THREE.Vector3()
    meshRef.current.getWorldPosition(currentWorldPos)

    if (bbox.intersectsBox(exclusionBox)) {
      console.log(`🚫 PDF ${id} dans la zone d'exclusion — repositionnement.`)
      const newWorldPos = currentWorldPos.clone()
      newWorldPos.y = anchor.y + exclusionZoneSize.y / 2 + 1
      setWorldPosition(meshRef.current, newWorldPos)
      return
    }

    // Check derrière
    const cameraPos = camera.position.clone()
    const camToAnchor = new THREE.Vector3().subVectors(anchor, cameraPos).normalize()
    const camToPDF = new THREE.Vector3().subVectors(currentWorldPos, cameraPos).normalize()

    const anchorDist = cameraPos.distanceTo(anchor)
    const pdfDist = cameraPos.distanceTo(currentWorldPos)
    const alignment = camToAnchor.dot(camToPDF)
    const isBehind = pdfDist > anchorDist && alignment > 0.85

    if (isBehind) {
      console.log(`🚫 PDF ${id} derrière la zone d'exclusion — repositionnement.`)
      const newWorldPos = currentWorldPos.clone()
      newWorldPos.y = anchor.y + exclusionZoneSize.y / 2 + 1
      setWorldPosition(meshRef.current, newWorldPos)
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

    fetch(`/api/pdf-info?filename=${encodeURIComponent(file)}`)
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

  const t0 = performance.now()
  console.log(`⏱️ Début fetch page ${currentPage}`)

  fetch(`/api/render-pdf?filename=${encodeURIComponent(file)}&page=${currentPage}`)
    .then(res => {
      console.log(`⏱️ Réponse reçue en ${(performance.now() - t0).toFixed(0)}ms`)
      return res.blob()
    })
    .then(blob => {
      console.log(`⏱️ Blob prêt en ${(performance.now() - t0).toFixed(0)}ms`)
      return createImageBitmap(blob)
    })
    .then(imageBitmap => {
      console.log(`⏱️ ImageBitmap prêt en ${(performance.now() - t0).toFixed(0)}ms`)
      const newTexture = new THREE.CanvasTexture(imageBitmap)
      newTexture.colorSpace = THREE.SRGBColorSpace
      newTexture.needsUpdate = true

      if (texture.current) texture.current.dispose()
      texture.current = newTexture

      if (meshRef.current) {
        meshRef.current.material.map = newTexture
        meshRef.current.material.needsUpdate = true
      }
      console.log(`⏱️ Texture appliquée en ${(performance.now() - t0).toFixed(0)}ms`)
    })
    .catch(err => console.error("Erreur:", err))
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
          position={[-0.68, 0.2 - index * 0.12, 0]}
          fontSize={0.06}
          maxWidth={1.2}
          lineHeight={1.1}
          anchorX="left"
          anchorY="middle"
          textAlign="left"
          overflowWrap="break-word"
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
  const [appStep, setAppStep] = useState('room-setup') 
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

  const [exclusionZoneSize, setExclusionZoneSize] = useState({ x: 1, y: 0.6, z: 0.1 })

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
    const fileURL = newFile
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


const handleAnchorSet = (position, dimensions = null) => {
  setAnchor(position)
  setHasAnchored(true)
  if (dimensions) {
    // On ajoute un peu de marge autour de l'écran
    console.log("LA TAILLE: " + dimensions)
    setExclusionZoneSize({
      x: dimensions.width,
      y: dimensions.height,
      z: 0.15  // profondeur fixe, l'écran est un plan
    })
  }
  console.log("🎯 Ancre définie à:", position, "| Taille écran:", dimensions)
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
          {/* ÉTAPE 1 — Room Setup */}
          {xrStarted && appStep === 'room-setup' && (
            <RoomCaptureManager onRoomReady={() => setAppStep('anchor-placement')} />
          )}

          {/* ÉTAPE 2 — Placement de l'ancre */}
          {xrStarted && appStep === 'anchor-placement' && (
            <ScreenAnchorSelector onAnchorSet={(position, dimensions) => {
              handleAnchorSet(position, dimensions)
              setAppStep('main-app')
            }} />
          )}

          {/* ÉTAPE 3 — App principale */}
          {xrStarted && appStep === 'main-app' && anchor && (
            <>
              <ExclusionZone anchor={anchor} size={exclusionZoneSize} />
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
                  exclusionZoneSize={exclusionZoneSize}
                />
              ))}
              <VRMenu addPDF={addPDF} pdfList={pdfList} anchor={anchor} />
            </>
          )}

          {/*WL PersistentAnchor toujours actif */}
          {xrStarted && (
            <PersistentAnchor
              position={anchor}
              onRestored={(position) => {
                handleAnchorRestored(position)
                setAppStep('main-app') // ancre restaurée → on skip les étapes 1 et 2
              }}
            />
          )}
        </XR>
      </Canvas>
    </div>
  )
}

export default App