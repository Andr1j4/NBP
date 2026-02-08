import { useNavigate } from "react-router-dom";
import "./Home.css"

function Home() {
    const navigate = useNavigate();

    return (
        <div className="home-container" >
            {/* Login dugme */}
            <button className="login-button" onClick={() => navigate("/Login")}>
                Login
            </button>

            <h1 className="home-title" >Online Tests</h1>
            <p className="home-subtitle" >Test your knowledge</p>

            <button className="start-button" onClick={() => navigate("/areas")}>
                Let's start
            </button>
        </div>
    );
}

export default Home;
