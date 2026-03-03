import { useState } from "react";
import { useNavigate } from "react-router-dom";
import axios from "axios";
import "./LogIn.css";

function Login() {
    const [username, setUsername] = useState("");
    const [password, setPassword] = useState("");
    const navigate = useNavigate();

    const handleLogin = async () => {
        if (!username.trim() || !password.trim()) {
            alert("Unesite korisničko ime i lozinku!");
            return;
        }

        try {
            const res = await axios.post("http://localhost:5000/api/login", { username, password });

            localStorage.setItem("token", res.data.token);
            localStorage.setItem("userId", res.data.user._id);
            localStorage.setItem("userRole", res.data.user.role);
            localStorage.setItem("username", res.data.user.username);

            alert(`Ulogovani ste kao ${res.data.user.role}!`);
            navigate("/areas");
        } catch (err) {
            console.error(err);
            alert("Neispravno korisničko ime ili lozinka");
        }
    };

    return (
        <div className="login-container">
            <div className="login-box">
                <h2>Login</h2>
                <input
                    type="text"
                    placeholder="Username"
                    value={username}
                    onChange={e => setUsername(e.target.value)}
                />
                <input
                    type="password"
                    placeholder="Password"
                    value={password}
                    onChange={e => setPassword(e.target.value)}
                />
                <button className="login-button" onClick={handleLogin}>Login</button>
                <button
                    className="register-button"
                    onClick={() => navigate("/register")}
                >
                    Nemate nalog? Registrujte se
                </button>
            </div>
        </div>
    );
}

export default Login;
