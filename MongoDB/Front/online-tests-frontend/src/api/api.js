import axios from "axios";

const api = axios.create({
    baseURL: "http://localhost:5000/api", // promeni ako tvoj backend ima drugaciju bazu URL
});

export default api;