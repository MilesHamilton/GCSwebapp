import MapView from './map/MapView'
import CommandPanel from './hud/CommandPanel'
import ReplayControls from './hud/ReplayControls'
import OperatorHud from './hud/OperatorHud'

function App() {
  return (
    <>
      <MapView />
      <CommandPanel />
      <ReplayControls />
      <OperatorHud />
    </>
  )
}

export default App
