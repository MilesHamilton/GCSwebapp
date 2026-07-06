import MapView from './map/MapView'
import CommandPanel from './hud/CommandPanel'
import ReplayControls from './hud/ReplayControls'
import OperatorHud from './hud/OperatorHud'
import WaypointPanel from './hud/WaypointPanel'

function App() {
  return (
    <>
      <MapView />
      <CommandPanel />
      <ReplayControls />
      <OperatorHud />
      <WaypointPanel />
    </>
  )
}

export default App
