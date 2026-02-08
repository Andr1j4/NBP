import './App.css';
import { BrowserRouter as Router, Routes, Route } from "react-router-dom";

import Home from "./pages/Home";
import Login from "./pages/LogIn";
import Areas from "./pages/Areas";
import Tests from "./pages/Tests";
import Kviz from "./pages/Kviz";

localStorage.clear();

const token = localStorage.getItem("token");

function App() {
    return (
        <Router>
            <Routes>
                <Route path="/" element={<Home />} />
                <Route path="/login" element={<Login />} />

                {/* Oblasti (Areas.js) */}
                <Route path="/areas" element={<Areas userId={localStorage.getItem("userId")} />} />
                {/*<Route path="/areas/:oblastId" element={<Areas />} />*/}

                {/* Testovi u jednoj bolasti (Tests.js) */}
                <Route path="/areas/:oblastId/tests" element={<Tests userId={localStorage.getItem("userId")} />} />

                {/* Pitanja u jednom testu (Kviz.js) */}
                <Route path="/areas/:oblastId/testovi/:testId" element={<Kviz userId={localStorage.getItem("userId")} />} />
            </Routes>
        </Router>
    );
}

export default App;
