import { useState } from "react";
import { useNavigate } from "react-router-dom";
import axios from "axios";
import "./LogIn.css";

function Register() {
    const navigate = useNavigate();

    const [form, setForm] = useState({
        username: "",
        email: "",
        password: "",
        role: "student"
    });

    const handleChange = (e) => {
        setForm({
            ...form,
            [e.target.name]: e.target.value
        });
    };

    const handleRegister = async () => {
        if (!form.username || !form.email || !form.password) {
            alert("Popunite sva polja!");
            return;
        }

        try {
            await axios.post("http://localhost:5000/api/register", form);
            alert("Registracija uspesna!");
            navigate("/login");
        } catch (err) {
            console.error(err);
            alert(err.response?.data?.message || "Greska pri registraciji");
        }
    };

    return (
        <div className="login-container">
            <div className="login-box">
                <h2>Registracija</h2>

                <input
                    type="text"
                    name="username"
                    placeholder="Username"
                    value={form.username}
                    onChange={handleChange}
                />

                <input
                    type="email"
                    name="email"
                    placeholder="Email"
                    value={form.email}
                    onChange={handleChange}
                />

                <input
                    type="password"
                    name="password"
                    placeholder="Password"
                    value={form.password}
                    onChange={handleChange}
                />
                <select
                    name="role"
                    value={form.role}
                    onChange={handleChange}
                    className="role-select"
                >
                    <option value="student">Student</option>
                    <option value="profesor">Profesor</option>
                    <option value="admin">Admin</option>
                </select>

                <button className="login-button" onClick={handleRegister}>
                    Registruj se
                </button>

                <button
                    className="register-button"
                    onClick={() => navigate("/login")}
                >
                    Vec imate nalog? Login
                </button>
            </div>
        </div>
    );
}

export default Register;