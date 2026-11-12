import { Link } from 'react-router-dom';
import { FloorPlanMaker } from '../components/FloorPlanMaker';

/** The stand-alone floor plan maker (/floor-plan). The same maker opens from the Photos step of the listing form. */
export default function FloorPlan() {
  return (
    <div className="stack" style={{ gap: 18 }}>
      <div className="page-head">
        <div>
          <div className="eyebrow">Floor plan maker</div>
          <h2 style={{ marginTop: 6 }}>Draw a floor plan from your measurements</h2>
          <p className="muted" style={{ marginTop: 6 }}>Type in each room’s width and length, and Streetkey draws a clean plan to scale with every room’s size and the total floor area in m² and sq ft. Download it as a picture, or add it to your listing.</p>
        </div>
        <Link to="/list" className="btn ghost sm">List a property</Link>
      </div>
      <FloorPlanMaker />
      <p className="small muted">Selling or letting? <Link to="/list">List your property</Link> and choose “Make a floor plan” on the Photos step: the rooms you’ve entered here will be waiting for you.</p>
    </div>
  );
}
