import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import axios from "axios";
import "./LayoutAdd.css";
import "./Areas.css";
import "./Modal.css";

function Areas() {
    const navigate = useNavigate();
    const [oblasti, setOblasti] = useState([]);
    const [novaOblast, setNovaOblast] = useState("");
    const [loading, setLoading] = useState(true);
    const [showModal, setShowModal] = useState(false);

    const userRole = localStorage.getItem("userRole");

    const token = localStorage.getItem("token");
    const isLoggedIn = !!token;

    useEffect(() => {
        fetchOblasti();
    }, []);

    const fetchOblasti = async () => {
        setLoading(true);
        try {
            const res = await axios.get("http://localhost:5000/api/oblasti");
            setOblasti(Array.isArray(res.data) ? res.data : []);
        } catch (err) {
            console.error("Greška pri dohvatanju oblasti:", err);
            setOblasti([]);
        } finally {
            setLoading(false);
        }
    };

    const dodajOblast = async () => {
        if (!novaOblast.trim()) return;

        //const token = localStorage.getItem("token");
        try {
            const res = await axios.post(
                "http://localhost:5000/api/oblasti",
                { naziv: novaOblast },
                { headers: { Authorization: `Bearer ${localStorage.getItem("token")}` } }
            );
            setOblasti([...oblasti, res.data]);
            setNovaOblast("");
            setShowModal(false);
        } catch (err) {
            console.error("Greška pri dodavanju oblasti:", err);
            alert("Nemate dozvolu ili greška servera");
        }
    };

    const obrisiOblast = async (oblastId) => {
        if (!window.confirm("Da li ste sigurni da zelite da obrisete oblast i sve testove?")) return;

        const token = localStorage.getItem("token");
        try {
            await axios.delete(`http://localhost:5000/api/oblasti/${oblastId}`, {
                headers: { Authorization: `Bearer ${token}` }
            });
            setOblasti(oblasti.filter(o => o._id !== oblastId));
        } catch (err) {
            console.error("Greška pri brisanju oblasti:", err);
            alert("Nemate dozvolu ili greška servera");
        }
    };

    return (
        <>
            <div className="admin-container">
                <div className="admin-left">
                    <h1>Oblasti</h1>
                    {loading && <p>Ucitanje...</p>}
                    {!loading && oblasti.length === 0 && <p>Nema oblasti.</p>}
                    <div className="areas-list">
                        {oblasti.map(o => (
                            <div key={o._id} className="area-card">
                                <button
                                    className="area-btn"
                                    onClick={() => navigate(`/areas/${o._id}/tests`)}
                                >
                                    {o.naziv}
                                </button>
                                {userRole === "admin" && (
                                    <button
                                        className="delete-btn"
                                        onClick={() => obrisiOblast(o._id)}
                                    >
                                        Obrisi
                                    </button>
                                )}
                            </div>
                        ))}
                    </div>
                </div>

                <div className="admin-right">
                    <h2>Upravljanje</h2>
                    {userRole === "admin" && (
                        <button onClick={() => setShowModal(true)}>➕ Dodaj oblast</button>
                    )}

                    <button style={{ marginTop: "10px" }} onClick={() => navigate("/")}>
                        ⬅ Nazad na Pocetnu Stranicu
                    </button>

                    {isLoggedIn ? (
                        <button
                            style={{ marginTop: "10px" }}
                            onClick={() => {
                                localStorage.clear();
                                navigate("/login");
                            }}
                        >
                            🚪 Logout
                        </button>
                    ) : (
                        <button
                            style={{ marginTop: "10px" }}
                            onClick={() => navigate("/login")}
                        >
                            🔐 Login
                        </button>
                    )}
                </div>
            </div>

            {showModal && (
                <div className="modal-overlay">
                    <div className="modal">
                        <h2>Nova oblast</h2>
                        <input
                            type="text"
                            placeholder="Naziv oblasti"
                            value={novaOblast}
                            onChange={e => setNovaOblast(e.target.value)}
                        />
                        <div className="modal-actions">
                            <button onClick={() => setShowModal(false)}>Otkaži</button>
                            <button onClick={dodajOblast}>Sačuvaj</button>
                        </div>
                    </div>
                </div>
            )}
        </>
    );
}

export default Areas;

